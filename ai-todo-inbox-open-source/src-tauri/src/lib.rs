use reqwest::header::CONTENT_TYPE;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use tauri::{
  menu::{MenuBuilder, MenuItemBuilder},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, WindowEvent,
};

const MAIN_WINDOW_LABEL: &str = "main";
const TRAY_SHOW_ID: &str = "tray_show";
const TRAY_HIDE_ID: &str = "tray_hide";
const TRAY_QUIT_ID: &str = "tray_quit";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiChatRequest {
  base_url: String,
  api_key: String,
  model: String,
  messages: Vec<AiChatMessage>,
  #[serde(default)]
  use_json_response_format: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct AiChatMessage {
  role: String,
  content: String,
}

fn preview_text(input: &str, max_chars: usize) -> String {
  input.chars().take(max_chars).collect()
}

#[tauri::command]
async fn ai_chat_completion(payload: AiChatRequest) -> Result<Value, String> {
  let base_url = payload.base_url.trim().trim_end_matches('/').to_string();
  let api_key = payload.api_key.trim().to_string();
  let model = payload.model.trim().to_string();

  if base_url.is_empty() {
    return Err("AI base URL 未配置。".into());
  }

  if model.is_empty() {
    return Err("AI 模型未配置。".into());
  }

  let mut body = json!({
    "model": model,
    "temperature": 0.2,
    "messages": payload.messages,
  });

  if payload.use_json_response_format {
    body["response_format"] = json!({ "type": "json_object" });
  }

  let client = reqwest::Client::new();
  let mut request = client
    .post(format!("{base_url}/chat/completions"))
    .header(CONTENT_TYPE, "application/json")
    .json(&body);

  if !api_key.is_empty() {
    request = request.bearer_auth(api_key);
  }

  let response = request
    .send()
    .await
    .map_err(|error| format!("AI 请求失败：{error}"))?;

  let status = response.status();
  let content_type = response
    .headers()
    .get(CONTENT_TYPE)
    .and_then(|value| value.to_str().ok())
    .unwrap_or_default()
    .to_string();
  let response_text = response
    .text()
    .await
    .map_err(|error| format!("AI 响应读取失败：{error}"))?;

  if !content_type.contains("application/json")
    && response_text
      .to_ascii_lowercase()
      .contains("<!doctype html>")
  {
    return Err("AI 接口返回了 HTML 页面，请检查 base URL 是否正确。".into());
  }

  let data: Value = serde_json::from_str(&response_text).map_err(|_| {
    format!(
      "AI 接口没有返回合法 JSON。前 120 个字符：{}",
      preview_text(&response_text, 120)
    )
  })?;

  if !status.is_success() {
    if let Some(message) = data
      .get("error")
      .and_then(|error| error.get("message"))
      .and_then(Value::as_str)
    {
      return Err(message.to_string());
    }

    return Err(format!("AI request failed with status {}", status.as_u16()));
  }

  Ok(data)
}

fn show_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

fn hide_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let _ = window.hide();
  }
}

fn toggle_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
    let is_visible = window.is_visible().unwrap_or(false);
    let is_minimized = window.is_minimized().unwrap_or(false);

    if is_visible && !is_minimized {
      let _ = window.hide();
    } else {
      let _ = window.show();
      let _ = window.unminimize();
      let _ = window.set_focus();
    }
  }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
  let show_item = MenuItemBuilder::with_id(TRAY_SHOW_ID, "打开 AI Inbox").build(app)?;
  let hide_item = MenuItemBuilder::with_id(TRAY_HIDE_ID, "隐藏窗口").build(app)?;
  let quit_item = MenuItemBuilder::with_id(TRAY_QUIT_ID, "退出").build(app)?;

  let menu = MenuBuilder::new(app)
    .item(&show_item)
    .item(&hide_item)
    .separator()
    .item(&quit_item)
    .build()?;

  let builder = TrayIconBuilder::with_id("main-tray")
    .menu(&menu)
    .show_menu_on_left_click(false)
    .on_tray_icon_event(|tray, event| {
      if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
      } = event
      {
        toggle_main_window(tray.app_handle());
      }
    })
    .on_menu_event(|app, event| match event.id().as_ref() {
      TRAY_SHOW_ID => show_main_window(app),
      TRAY_HIDE_ID => hide_main_window(app),
      TRAY_QUIT_ID => app.exit(0),
      _ => {}
    });

  if let Some(icon) = app.default_window_icon() {
    builder.icon(icon.clone()).build(app)?;
  } else {
    builder.build(app)?;
  }

  Ok(())
}

fn cleanup_webview_cache(app: &tauri::App) {
  let Ok(local_data_dir) = app.path().app_local_data_dir() else {
    return;
  };

  let webview_default_dir = local_data_dir.join("EBWebView").join("Default");
  let cleanup_targets = [
    webview_default_dir.join("Service Worker"),
    webview_default_dir.join("Cache").join("Cache_Data"),
    webview_default_dir.join("Code Cache").join("js"),
    webview_default_dir.join("Code Cache").join("wasm"),
  ];

  for target in cleanup_targets {
    if target.exists() {
      let _ = fs::remove_dir_all(target);
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![ai_chat_completion])
    .on_window_event(|window, event| {
      if window.label() != MAIN_WINDOW_LABEL {
        return;
      }

      if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .plugin(tauri_plugin_notification::init())
    .setup(|app| {
      cleanup_webview_cache(app);
      build_tray(app.handle())?;
      hide_main_window(app.handle());

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
