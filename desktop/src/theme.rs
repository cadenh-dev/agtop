use gpui::{Hsla, rgb};

// One palette for the native workbench. The accent marks selection and primary actions.
pub const BACKGROUND: u32 = 0x101714;
pub const PANEL: u32 = 0x17211c;
pub const RAISED: u32 = 0x202e26;
pub const LINE: u32 = 0x304238;
pub const TEXT: u32 = 0xe6eee8;
pub const MUTED: u32 = 0x9aafa0;
pub const ACCENT: u32 = 0xc7ef91;
pub const DANGER: u32 = 0xf19a8c;
pub const FONT: &str = if cfg!(target_os = "macos") {
    ".SystemUIFont"
} else if cfg!(target_os = "windows") {
    "Segoe UI"
} else {
    "DejaVu Sans"
};
pub const MONO: &str = if cfg!(target_os = "macos") {
    "Menlo"
} else if cfg!(target_os = "windows") {
    "Consolas"
} else {
    "DejaVu Sans Mono"
};
pub fn color(value: u32) -> Hsla {
    rgb(value).into()
}
