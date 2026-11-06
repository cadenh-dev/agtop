#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
mod client;
mod input;
mod model;
mod theme;
mod ui;

use gpui::{
    App, AppContext, Application, Bounds, TitlebarOptions, WindowBounds, WindowOptions, px, size,
};

fn main() -> anyhow::Result<()> {
    let config = client::Config::from_args()?;
    Application::new().run(move |cx: &mut App| {
        ui::init(cx);
        let bounds = Bounds::centered(None, size(px(1280.), px(820.)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(1060.), px(680.))),
                titlebar: Some(TitlebarOptions {
                    title: Some("agtop — Agent process manager".into()),
                    appears_transparent: false,
                    ..Default::default()
                }),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| ui::Workbench::new(config, window, cx)),
        )
        .expect("Unable to open GPUI window");
        cx.on_window_closed(|cx| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();
        cx.activate(true);
    });
    Ok(())
}
