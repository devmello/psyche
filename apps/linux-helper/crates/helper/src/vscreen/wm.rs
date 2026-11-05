//! The window manager as a pure state machine (linux-desktop design §7.1).
//!
//! The helper is the only window manager on the virtual display. It keeps one window in front:
//! a normal top-level is mapped maximised and focused, a dialog is centred over its parent and
//! focused, a menu or tooltip is mapped where it asks and never takes the focus. There are no
//! frames and no reparenting, so a window's coordinates are screen coordinates and AT-SPI
//! positions stay exact.
//!
//! `Wm` knows nothing about X: the driver (`wmdriver.rs`) turns X events into `WmEvent`s and
//! applies the `WmAction`s that come back, which is also how the tests drive it, with fake events.

use std::collections::HashMap;

pub type WinId = u32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self {
            x,
            y,
            w: w.max(1),
            h: h.max(1),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowKind {
    Normal,
    Dialog,
    /// Menus, tooltips, combo boxes, drag icons, notifications: placed where they ask.
    Popup,
    Splash,
    Dock,
    Desktop,
}

impl WindowKind {
    fn takes_focus(self) -> bool {
        matches!(self, WindowKind::Normal | WindowKind::Dialog)
    }
}

/// What the driver read from the window's properties.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowInfo {
    pub id: WinId,
    pub kind: WindowKind,
    pub transient_for: Option<WinId>,
    /// The geometry the client asked for (or its current one).
    pub requested: Rect,
    /// `WM_HINTS` input flag (default true).
    pub input_hint: bool,
    pub supports_take_focus: bool,
    pub supports_delete: bool,
    pub title: Option<String>,
    pub pid: Option<u32>,
}

impl WindowInfo {
    pub fn new(id: WinId, kind: WindowKind, requested: Rect) -> Self {
        Self {
            id,
            kind,
            transient_for: None,
            requested,
            input_hint: true,
            supports_take_focus: false,
            supports_delete: true,
            title: None,
            pid: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WmEvent {
    MapRequest(WindowInfo),
    /// The window went away or was withdrawn (UnmapNotify / DestroyNotify).
    Gone(WinId),
    ConfigureRequest {
        win: WinId,
        rect: Rect,
    },
    /// A property changed (title, pid): update what we show, move nothing.
    InfoChanged(WindowInfo),
    /// `_NET_ACTIVE_WINDOW`
    Activate(WinId),
    /// `_NET_CLOSE_WINDOW`
    Close(WinId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FocusMethod {
    SetInputFocus,
    TakeFocus,
    /// A "no input" window: it is raised but never given the focus.
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WmAction {
    Configure {
        win: WinId,
        rect: Rect,
    },
    /// ICCCM: a client whose request was ignored is told its (unchanged) geometry.
    SyntheticConfigureNotify {
        win: WinId,
        rect: Rect,
    },
    Map(WinId),
    Raise(WinId),
    Lower(WinId),
    Focus {
        win: WinId,
        method: FocusMethod,
    },
    /// Ask the window to close (`WM_DELETE_WINDOW`), or kill its connection if it cannot.
    RequestClose {
        win: WinId,
        supports_delete: bool,
    },
    /// `_NET_CLIENT_LIST` and `_NET_ACTIVE_WINDOW` on the root.
    Publish {
        client_list: Vec<WinId>,
        active: Option<WinId>,
    },
}

#[derive(Debug, Clone)]
struct Managed {
    info: WindowInfo,
    rect: Rect,
}

pub struct Wm {
    screen: (u32, u32),
    windows: HashMap<WinId, Managed>,
    /// Mapping order, oldest first (`_NET_CLIENT_LIST`).
    order: Vec<WinId>,
    /// Focusable windows, top of the stack last.
    focus_stack: Vec<WinId>,
    active: Option<WinId>,
}

impl Wm {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            screen: (width.max(1), height.max(1)),
            windows: HashMap::new(),
            order: Vec::new(),
            focus_stack: Vec::new(),
            active: None,
        }
    }

    pub fn screen(&self) -> (u32, u32) {
        self.screen
    }

    pub fn active(&self) -> Option<WinId> {
        self.active
    }

    pub fn is_managed(&self, win: WinId) -> bool {
        self.windows.contains_key(&win)
    }

    pub fn rect_of(&self, win: WinId) -> Option<Rect> {
        self.windows.get(&win).map(|m| m.rect)
    }

    pub fn info_of(&self, win: WinId) -> Option<&WindowInfo> {
        self.windows.get(&win).map(|m| &m.info)
    }

    /// Mapped windows, oldest first.
    pub fn client_list(&self) -> Vec<WinId> {
        self.order.clone()
    }

    pub fn handle(&mut self, event: WmEvent) -> Vec<WmAction> {
        let before = (self.order.clone(), self.active);
        let mut actions = match event {
            WmEvent::MapRequest(info) => self.map_request(info),
            WmEvent::Gone(win) => self.gone(win),
            WmEvent::ConfigureRequest { win, rect } => self.configure_request(win, rect),
            WmEvent::InfoChanged(info) => {
                if let Some(m) = self.windows.get_mut(&info.id) {
                    m.info.title = info.title;
                    m.info.pid = info.pid;
                    m.info.supports_delete = info.supports_delete;
                }
                Vec::new()
            }
            WmEvent::Activate(win) => self.activate(win),
            WmEvent::Close(win) => match self.windows.get(&win) {
                Some(m) => vec![WmAction::RequestClose {
                    win,
                    supports_delete: m.info.supports_delete,
                }],
                None => Vec::new(),
            },
        };
        if (self.order.clone(), self.active) != before {
            actions.push(WmAction::Publish {
                client_list: self.order.clone(),
                active: self.active,
            });
        }
        actions
    }

    fn clamp(&self, rect: Rect) -> Rect {
        let (sw, sh) = self.screen;
        let w = rect.w.min(sw);
        let h = rect.h.min(sh);
        let x = rect.x.clamp(0, (sw - w) as i32);
        let y = rect.y.clamp(0, (sh - h) as i32);
        Rect::new(x, y, w, h)
    }

    fn centred_over(&self, size: Rect, parent: Option<Rect>) -> Rect {
        let (sw, sh) = self.screen;
        let w = size.w.min(sw);
        let h = size.h.min(sh);
        let around = parent.unwrap_or(Rect::new(0, 0, sw, sh));
        let x = around.x + (around.w as i32 - w as i32) / 2;
        let y = around.y + (around.h as i32 - h as i32) / 2;
        self.clamp(Rect::new(x, y, w, h))
    }

    fn full(&self) -> Rect {
        Rect::new(0, 0, self.screen.0, self.screen.1)
    }

    fn focus_action(&self, win: WinId) -> Option<WmAction> {
        let info = &self.windows.get(&win)?.info;
        let method = match (info.input_hint, info.supports_take_focus) {
            (true, false) => FocusMethod::SetInputFocus,
            (_, true) => FocusMethod::TakeFocus,
            (false, false) => FocusMethod::Nothing,
        };
        Some(WmAction::Focus { win, method })
    }

    fn make_active(&mut self, win: WinId, actions: &mut Vec<WmAction>) {
        self.focus_stack.retain(|w| *w != win);
        self.focus_stack.push(win);
        self.active = Some(win);
        actions.push(WmAction::Raise(win));
        if let Some(a) = self.focus_action(win) {
            actions.push(a);
        }
    }

    fn map_request(&mut self, info: WindowInfo) -> Vec<WmAction> {
        let id = info.id;
        let parent_rect = info
            .transient_for
            .and_then(|p| self.windows.get(&p))
            .map(|m| m.rect);
        let kind = if info.kind == WindowKind::Normal && info.transient_for.is_some() {
            WindowKind::Dialog
        } else {
            info.kind
        };
        let rect = match kind {
            WindowKind::Normal => self.full(),
            WindowKind::Dialog => self.centred_over(info.requested, parent_rect),
            WindowKind::Splash => self.centred_over(info.requested, None),
            WindowKind::Popup | WindowKind::Dock => self.clamp(info.requested),
            WindowKind::Desktop => self.full(),
        };
        let mut info = info;
        info.kind = kind;
        if !self.windows.contains_key(&id) {
            self.order.push(id);
        }
        self.windows.insert(id, Managed { info, rect });
        let mut actions = vec![WmAction::Configure { win: id, rect }, WmAction::Map(id)];
        match kind {
            WindowKind::Normal | WindowKind::Dialog => self.make_active(id, &mut actions),
            WindowKind::Desktop => actions.push(WmAction::Lower(id)),
            _ => actions.push(WmAction::Raise(id)),
        }
        actions
    }

    fn gone(&mut self, win: WinId) -> Vec<WmAction> {
        let Some(removed) = self.windows.remove(&win) else {
            return Vec::new();
        };
        self.order.retain(|w| *w != win);
        self.focus_stack.retain(|w| *w != win);
        let mut actions = Vec::new();
        if self.active == Some(win) {
            self.active = None;
            // A closed dialog hands the focus back to its parent, otherwise the next one down.
            let next = removed
                .info
                .transient_for
                .filter(|p| self.focus_stack.contains(p))
                .or_else(|| self.focus_stack.last().copied());
            if let Some(next) = next {
                self.make_active(next, &mut actions);
            }
        }
        actions
    }

    fn configure_request(&mut self, win: WinId, rect: Rect) -> Vec<WmAction> {
        let Some(managed) = self.windows.get(&win) else {
            // Not mapped yet: ICCCM wants the request honoured.
            return vec![WmAction::Configure { win, rect }];
        };
        match managed.info.kind {
            WindowKind::Normal | WindowKind::Desktop => vec![WmAction::SyntheticConfigureNotify {
                win,
                rect: managed.rect,
            }],
            WindowKind::Dialog | WindowKind::Splash => {
                let parent = managed
                    .info
                    .transient_for
                    .and_then(|p| self.windows.get(&p))
                    .map(|m| m.rect);
                let new = if managed.info.kind == WindowKind::Splash {
                    self.centred_over(rect, None)
                } else {
                    self.centred_over(rect, parent)
                };
                self.windows.get_mut(&win).expect("present").rect = new;
                vec![WmAction::Configure { win, rect: new }]
            }
            WindowKind::Popup | WindowKind::Dock => {
                let new = self.clamp(rect);
                self.windows.get_mut(&win).expect("present").rect = new;
                vec![WmAction::Configure { win, rect: new }]
            }
        }
    }

    fn activate(&mut self, win: WinId) -> Vec<WmAction> {
        let Some(m) = self.windows.get(&win) else {
            return Vec::new();
        };
        if !m.info.kind.takes_focus() {
            return Vec::new();
        }
        // An open dialog of that window gets the focus instead (the parent is modal to it).
        let target = self
            .focus_stack
            .iter()
            .rev()
            .find(|w| {
                self.windows
                    .get(w)
                    .is_some_and(|c| c.info.transient_for == Some(win))
            })
            .copied()
            .unwrap_or(win);
        let mut actions = Vec::new();
        if target != win {
            self.make_active(win, &mut actions);
        }
        self.make_active(target, &mut actions);
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: (u32, u32) = (1280, 800);

    fn wm() -> Wm {
        Wm::new(SCREEN.0, SCREEN.1)
    }

    fn normal(id: WinId) -> WindowInfo {
        WindowInfo::new(id, WindowKind::Normal, Rect::new(10, 10, 300, 200))
    }

    fn dialog(id: WinId, parent: WinId) -> WindowInfo {
        let mut info = WindowInfo::new(id, WindowKind::Dialog, Rect::new(0, 0, 400, 150));
        info.transient_for = Some(parent);
        info
    }

    fn focused(actions: &[WmAction]) -> Option<WinId> {
        actions.iter().rev().find_map(|a| match a {
            WmAction::Focus { win, .. } => Some(*win),
            _ => None,
        })
    }

    #[test]
    fn a_normal_window_is_maximised_raised_and_focused() {
        let mut wm = wm();
        let actions = wm.handle(WmEvent::MapRequest(normal(1)));
        assert_eq!(
            actions[0],
            WmAction::Configure {
                win: 1,
                rect: Rect::new(0, 0, 1280, 800)
            }
        );
        assert!(actions.contains(&WmAction::Map(1)));
        assert!(actions.contains(&WmAction::Raise(1)));
        assert_eq!(focused(&actions), Some(1));
        assert_eq!(wm.active(), Some(1));
        assert!(actions.contains(&WmAction::Publish {
            client_list: vec![1],
            active: Some(1)
        }));
    }

    #[test]
    fn the_newest_window_is_in_front_and_closing_it_brings_back_the_one_below() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        wm.handle(WmEvent::MapRequest(normal(2)));
        assert_eq!(wm.active(), Some(2));
        let actions = wm.handle(WmEvent::Gone(2));
        assert_eq!(focused(&actions), Some(1));
        assert!(actions.contains(&WmAction::Raise(1)));
        assert_eq!(wm.client_list(), vec![1]);
    }

    #[test]
    fn a_dialog_is_centred_over_its_parent_and_focused() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let actions = wm.handle(WmEvent::MapRequest(dialog(2, 1)));
        assert_eq!(
            actions[0],
            WmAction::Configure {
                win: 2,
                rect: Rect::new(440, 325, 400, 150)
            }
        );
        assert_eq!(focused(&actions), Some(2));
    }

    #[test]
    fn a_transient_normal_window_is_treated_as_a_dialog() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let mut w = normal(2);
        w.transient_for = Some(1);
        w.requested = Rect::new(0, 0, 200, 100);
        wm.handle(WmEvent::MapRequest(w));
        assert_eq!(wm.info_of(2).unwrap().kind, WindowKind::Dialog);
        assert_eq!(wm.rect_of(2), Some(Rect::new(540, 350, 200, 100)));
    }

    #[test]
    fn a_dialog_bigger_than_the_screen_is_clamped() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let mut d = dialog(2, 1);
        d.requested = Rect::new(0, 0, 5000, 4000);
        wm.handle(WmEvent::MapRequest(d));
        assert_eq!(wm.rect_of(2), Some(Rect::new(0, 0, 1280, 800)));
    }

    #[test]
    fn closing_a_dialog_returns_the_focus_to_its_parent() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        wm.handle(WmEvent::MapRequest(normal(3)));
        wm.handle(WmEvent::MapRequest(dialog(2, 1)));
        // The parent was not the top window; the dialog still hands back to it.
        let actions = wm.handle(WmEvent::Gone(2));
        assert_eq!(focused(&actions), Some(1));
    }

    #[test]
    fn menus_and_tooltips_never_take_the_focus() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let popup = WindowInfo::new(5, WindowKind::Popup, Rect::new(100, 120, 200, 300));
        let actions = wm.handle(WmEvent::MapRequest(popup));
        assert_eq!(
            actions[0],
            WmAction::Configure {
                win: 5,
                rect: Rect::new(100, 120, 200, 300)
            }
        );
        assert_eq!(focused(&actions), None);
        assert_eq!(wm.active(), Some(1));
        let actions = wm.handle(WmEvent::Gone(5));
        assert_eq!(focused(&actions), None);
    }

    #[test]
    fn docks_and_desktops_are_placed_but_not_focused() {
        let mut wm = wm();
        let dock = WindowInfo::new(7, WindowKind::Dock, Rect::new(0, 780, 1280, 20));
        let actions = wm.handle(WmEvent::MapRequest(dock));
        assert_eq!(focused(&actions), None);
        let desktop = WindowInfo::new(8, WindowKind::Desktop, Rect::new(0, 0, 10, 10));
        let actions = wm.handle(WmEvent::MapRequest(desktop));
        assert!(actions.contains(&WmAction::Lower(8)));
        assert_eq!(wm.active(), None);
    }

    #[test]
    fn a_maximised_window_that_asks_to_resize_is_told_its_geometry() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let actions = wm.handle(WmEvent::ConfigureRequest {
            win: 1,
            rect: Rect::new(5, 5, 50, 50),
        });
        assert_eq!(
            actions,
            vec![WmAction::SyntheticConfigureNotify {
                win: 1,
                rect: Rect::new(0, 0, 1280, 800)
            }]
        );
    }

    #[test]
    fn a_dialog_that_resizes_stays_centred() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        wm.handle(WmEvent::MapRequest(dialog(2, 1)));
        let actions = wm.handle(WmEvent::ConfigureRequest {
            win: 2,
            rect: Rect::new(0, 0, 600, 400),
        });
        assert_eq!(
            actions,
            vec![WmAction::Configure {
                win: 2,
                rect: Rect::new(340, 200, 600, 400)
            }]
        );
    }

    #[test]
    fn an_unmapped_window_gets_the_geometry_it_asked_for() {
        let mut wm = wm();
        let rect = Rect::new(1, 2, 3, 4);
        assert_eq!(
            wm.handle(WmEvent::ConfigureRequest { win: 9, rect }),
            vec![WmAction::Configure { win: 9, rect }]
        );
    }

    #[test]
    fn activating_a_window_with_an_open_dialog_focuses_the_dialog() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        wm.handle(WmEvent::MapRequest(dialog(2, 1)));
        wm.handle(WmEvent::MapRequest(normal(3)));
        let actions = wm.handle(WmEvent::Activate(1));
        assert_eq!(focused(&actions), Some(2));
        assert_eq!(wm.active(), Some(2));
    }

    #[test]
    fn focus_follows_the_icccm_input_models() {
        let mut wm = wm();
        let mut passive = normal(1);
        passive.input_hint = true;
        assert!(matches!(
            wm.handle(WmEvent::MapRequest(passive))
                .iter()
                .find(|a| matches!(a, WmAction::Focus { .. })),
            Some(WmAction::Focus {
                method: FocusMethod::SetInputFocus,
                ..
            })
        ));
        let mut global = normal(2);
        global.input_hint = false;
        global.supports_take_focus = true;
        assert!(matches!(
            wm.handle(WmEvent::MapRequest(global))
                .iter()
                .find(|a| matches!(a, WmAction::Focus { .. })),
            Some(WmAction::Focus {
                method: FocusMethod::TakeFocus,
                ..
            })
        ));
        let mut none = normal(3);
        none.input_hint = false;
        assert!(matches!(
            wm.handle(WmEvent::MapRequest(none))
                .iter()
                .find(|a| matches!(a, WmAction::Focus { .. })),
            Some(WmAction::Focus {
                method: FocusMethod::Nothing,
                ..
            })
        ));
    }

    #[test]
    fn close_requests_name_the_window_and_unknown_events_do_nothing() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        assert_eq!(
            wm.handle(WmEvent::Close(1)),
            vec![WmAction::RequestClose {
                win: 1,
                supports_delete: true
            }]
        );
        assert!(wm.handle(WmEvent::Close(99)).is_empty());
        assert!(wm.handle(WmEvent::Gone(99)).is_empty());
        assert!(wm.handle(WmEvent::Activate(99)).is_empty());
    }

    #[test]
    fn title_changes_update_the_record_without_moving_anything() {
        let mut wm = wm();
        wm.handle(WmEvent::MapRequest(normal(1)));
        let mut info = normal(1);
        info.title = Some("Untitled".into());
        info.pid = Some(42);
        assert!(wm.handle(WmEvent::InfoChanged(info)).is_empty());
        assert_eq!(wm.info_of(1).unwrap().title.as_deref(), Some("Untitled"));
        assert_eq!(wm.info_of(1).unwrap().pid, Some(42));
    }
}
