# Third-party code

`src/input.rs` is adapted from `examples/input.rs` in GPUI 0.2.2, published by Zed Industries under Apache-2.0. The original license is retained in `licenses/GPUI-APACHE.txt`.

Local changes add constructors, scoped Windows/Linux key bindings, application colors, compact styling, focus handling, and a composition-selection offset fix. The desktop uses the GPUI crate directly; it does not embed a web view.
