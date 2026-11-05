//! AT-SPI roles -> the Mac `AX*` role vocabulary. The snapshot builder, the Gateway
//! (`MENU_ROLES`, element map) and the model all speak the Mac vocabulary (`button`, `textfield`,
//! `row:outlineRow`, `menubaritem`, ...), so every AT-SPI role is mapped onto it here, as pure
//! data, and the rest of the pipeline is shared. The role numbers are `AtspiRole` from
//! `atspi-constants.h` (checked against the installed header by a test on Linux).

/// `AtspiRole` values the table uses.
pub mod role {
    pub const ALERT: u32 = 2;
    pub const CALENDAR: u32 = 5;
    pub const CANVAS: u32 = 6;
    pub const CHECK_BOX: u32 = 7;
    pub const CHECK_MENU_ITEM: u32 = 8;
    pub const COLOR_CHOOSER: u32 = 9;
    pub const COLUMN_HEADER: u32 = 10;
    pub const COMBO_BOX: u32 = 11;
    pub const DATE_EDITOR: u32 = 12;
    pub const DIAL: u32 = 15;
    pub const DIALOG: u32 = 16;
    pub const DRAWING_AREA: u32 = 18;
    pub const FILE_CHOOSER: u32 = 19;
    pub const FILLER: u32 = 20;
    pub const FRAME: u32 = 23;
    pub const HTML_CONTAINER: u32 = 25;
    pub const ICON: u32 = 26;
    pub const IMAGE: u32 = 27;
    pub const INTERNAL_FRAME: u32 = 28;
    pub const LABEL: u32 = 29;
    pub const LIST: u32 = 31;
    pub const LIST_ITEM: u32 = 32;
    pub const MENU: u32 = 33;
    pub const MENU_BAR: u32 = 34;
    pub const MENU_ITEM: u32 = 35;
    pub const OPTION_PANE: u32 = 36;
    pub const PAGE_TAB: u32 = 37;
    pub const PAGE_TAB_LIST: u32 = 38;
    pub const PANEL: u32 = 39;
    pub const PASSWORD_TEXT: u32 = 40;
    pub const POPUP_MENU: u32 = 41;
    pub const PROGRESS_BAR: u32 = 42;
    pub const PUSH_BUTTON: u32 = 43;
    pub const RADIO_BUTTON: u32 = 44;
    pub const RADIO_MENU_ITEM: u32 = 45;
    pub const ROOT_PANE: u32 = 46;
    pub const ROW_HEADER: u32 = 47;
    pub const SCROLL_BAR: u32 = 48;
    pub const SCROLL_PANE: u32 = 49;
    pub const SEPARATOR: u32 = 50;
    pub const SLIDER: u32 = 51;
    pub const SPIN_BUTTON: u32 = 52;
    pub const SPLIT_PANE: u32 = 53;
    pub const STATUS_BAR: u32 = 54;
    pub const TABLE: u32 = 55;
    pub const TABLE_CELL: u32 = 56;
    pub const TABLE_COLUMN_HEADER: u32 = 57;
    pub const TABLE_ROW_HEADER: u32 = 58;
    pub const TEAROFF_MENU_ITEM: u32 = 59;
    pub const TERMINAL: u32 = 60;
    pub const TEXT: u32 = 61;
    pub const TOGGLE_BUTTON: u32 = 62;
    pub const TOOL_BAR: u32 = 63;
    pub const TOOL_TIP: u32 = 64;
    pub const TREE: u32 = 65;
    pub const TREE_TABLE: u32 = 66;
    pub const UNKNOWN: u32 = 67;
    pub const VIEWPORT: u32 = 68;
    pub const WINDOW: u32 = 69;
    pub const HEADER: u32 = 71;
    pub const FOOTER: u32 = 72;
    pub const PARAGRAPH: u32 = 73;
    pub const APPLICATION: u32 = 75;
    pub const AUTOCOMPLETE: u32 = 76;
    pub const EDITBAR: u32 = 77;
    pub const EMBEDDED: u32 = 78;
    pub const ENTRY: u32 = 79;
    pub const CAPTION: u32 = 81;
    pub const DOCUMENT_FRAME: u32 = 82;
    pub const HEADING: u32 = 83;
    pub const PAGE: u32 = 84;
    pub const SECTION: u32 = 85;
    pub const FORM: u32 = 87;
    pub const LINK: u32 = 88;
    pub const TABLE_ROW: u32 = 90;
    pub const TREE_ITEM: u32 = 91;
    pub const DOCUMENT_SPREADSHEET: u32 = 92;
    pub const DOCUMENT_PRESENTATION: u32 = 93;
    pub const DOCUMENT_TEXT: u32 = 94;
    pub const DOCUMENT_WEB: u32 = 95;
    pub const DOCUMENT_EMAIL: u32 = 96;
    pub const LIST_BOX: u32 = 98;
    pub const GROUPING: u32 = 99;
    pub const NOTIFICATION: u32 = 101;
    pub const INFO_BAR: u32 = 102;
    pub const LEVEL_BAR: u32 = 103;
    pub const TITLE_BAR: u32 = 104;
    pub const STATIC: u32 = 116;
    pub const PUSH_BUTTON_MENU: u32 = 129;
}

/// What the live source knows about one accessible, all read once per element.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AtspiFacts {
    pub role: u32,
    pub parent_role: Option<u32>,
    /// The element is the snapshot root and a top-level window.
    pub top_level: bool,
    /// `Accessible.GetAttributes`: the toolkit's own `id`.
    pub identifier: String,
    pub toolkit: String,
    // States.
    pub editable: bool,
    pub multi_line: bool,
    pub checkable: bool,
    pub expandable: bool,
    pub has_popup: bool,
    pub modal: bool,
    // Interfaces.
    pub action_names: Vec<String>,
    pub has_text: bool,
    pub has_editable_text: bool,
    pub has_value: bool,
    pub value_read_only: bool,
    pub has_selection_parent: bool,
    pub selectable: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Mapped {
    pub role: &'static str,
    pub subrole: Option<&'static str>,
    /// The accessible name is the element's text, not its title (static text): it goes to `value`.
    pub name_is_value: bool,
    /// The name is chrome (title bar): drop it so the container hoists its children.
    pub drop_name: bool,
}

fn m(role: &'static str, subrole: Option<&'static str>) -> Mapped {
    Mapped { role, subrole, name_is_value: false, drop_name: false }
}

fn looks_like_search(f: &AtspiFacts) -> bool {
    f.identifier.to_ascii_lowercase().contains("search")
}

/// `PASSWORD_TEXT` is the only secure role. The snapshot marks it `AXSecureTextField`, which the
/// builder redacts and never descends into, and the dispatch layer refuses.
pub fn is_password(role: u32) -> bool {
    role == role::PASSWORD_TEXT
}

/// AT-SPI role (plus a few facts) -> Mac role and subrole.
pub fn map_role(f: &AtspiFacts) -> Mapped {
    use role::*;
    if f.top_level && matches!(f.role, FRAME | WINDOW | DIALOG | ALERT | FILE_CHOOSER | COLOR_CHOOSER | PANEL | EMBEDDED) {
        let dialog = matches!(f.role, DIALOG | ALERT | FILE_CHOOSER | COLOR_CHOOSER) || f.modal;
        return m("AXWindow", Some(if dialog { "AXDialog" } else { "AXStandardWindow" }));
    }
    match f.role {
        PUSH_BUTTON => {
            if f.checkable {
                m("AXCheckBox", Some("AXToggle"))
            } else {
                m("AXButton", None)
            }
        }
        PUSH_BUTTON_MENU => m("AXMenuButton", None),
        TOGGLE_BUTTON => m("AXCheckBox", Some("AXToggle")),
        CHECK_BOX => m("AXCheckBox", None),
        CHECK_MENU_ITEM | RADIO_MENU_ITEM | TEAROFF_MENU_ITEM => m("AXMenuItem", None),
        COMBO_BOX => {
            if f.editable {
                m("AXComboBox", None)
            } else {
                m("AXPopUpButton", None)
            }
        }
        // GTK 4 exposes a Text widget as ENTRY, GTK 3 as TEXT; both are single line unless flagged.
        ENTRY | TEXT | AUTOCOMPLETE | EDITBAR => {
            if f.multi_line {
                m("AXTextArea", None)
            } else if looks_like_search(f) {
                m("AXTextField", Some("AXSearchField"))
            } else if f.role == TEXT && !f.editable {
                // Read-only text without a label role: a document body or a selectable label.
                Mapped { role: "AXStaticText", subrole: None, name_is_value: false, drop_name: false }
            } else {
                m("AXTextField", None)
            }
        }
        PASSWORD_TEXT => m("AXTextField", Some("AXSecureTextField")),
        TERMINAL => m("AXTextArea", None),
        DOCUMENT_WEB | HTML_CONTAINER => m("AXWebArea", None),
        DOCUMENT_FRAME | DOCUMENT_TEXT | DOCUMENT_EMAIL | DOCUMENT_SPREADSHEET | DOCUMENT_PRESENTATION => m("AXTextArea", None),
        LINK => m("AXLink", None),
        IMAGE | ICON | CANVAS | DRAWING_AREA => m("AXImage", None),
        LABEL | STATIC | CAPTION | PARAGRAPH => Mapped { role: "AXStaticText", subrole: None, name_is_value: true, drop_name: false },
        HEADING => m("AXHeading", None),
        LIST | LIST_BOX => m("AXList", None),
        LIST_ITEM | TABLE_ROW => m("AXRow", None),
        TREE | TREE_TABLE => m("AXOutline", None),
        TREE_ITEM => m("AXRow", Some("AXOutlineRow")),
        TABLE => m("AXTable", None),
        TABLE_CELL => m("AXCell", None),
        COLUMN_HEADER | TABLE_COLUMN_HEADER | ROW_HEADER | TABLE_ROW_HEADER => m("AXButton", Some("AXSortButton")),
        MENU | POPUP_MENU => m("AXMenu", None),
        MENU_BAR => m("AXMenuBar", None),
        MENU_ITEM => {
            if f.parent_role == Some(MENU_BAR) {
                m("AXMenuBarItem", None)
            } else {
                m("AXMenuItem", None)
            }
        }
        PAGE_TAB_LIST => m("AXTabGroup", None),
        PAGE_TAB => m("AXRadioButton", Some("AXTabButton")),
        RADIO_BUTTON => m("AXRadioButton", None),
        SLIDER | DIAL => m("AXSlider", None),
        SPIN_BUTTON => m("AXIncrementor", None),
        PROGRESS_BAR | LEVEL_BAR => m("AXProgressIndicator", None),
        TOOL_BAR => m("AXToolbar", None),
        STATUS_BAR | HEADER | FOOTER | INFO_BAR => m("AXGroup", None),
        TOOL_TIP => m("AXHelpTag", None),
        DATE_EDITOR | CALENDAR => m("AXDateField", None),
        COLOR_CHOOSER => m("AXColorWell", None),
        FRAME | WINDOW | INTERNAL_FRAME | OPTION_PANE => m("AXWindow", Some("AXStandardWindow")),
        DIALOG | ALERT | FILE_CHOOSER | NOTIFICATION => m("AXWindow", Some("AXDialog")),
        TITLE_BAR => Mapped { role: "AXGroup", subrole: None, name_is_value: false, drop_name: true },
        SCROLL_BAR => m("AXScrollBar", None),
        SEPARATOR => m("AXSplitter", None),
        SPLIT_PANE => m("AXSplitGroup", None),
        SCROLL_PANE | VIEWPORT => m("AXScrollArea", None),
        PANEL | FILLER | GROUPING | SECTION | FORM | PAGE | ROOT_PANE | EMBEDDED => m("AXGroup", None),
        APPLICATION => m("AXApplication", None),
        _ => m("AXUnknown", None),
    }
}

/// Raw AX action names an element offers, from its `Action` interface and facts. `DoAction`
/// names that mean "activate" become `AXPress`; list-like items open instead of press.
pub fn actions(f: &AtspiFacts, ax_role: &str) -> Vec<String> {
    use role::*;
    let mut out: Vec<&'static str> = Vec::new();
    let item = matches!(f.role, LIST_ITEM | TABLE_ROW | TREE_ITEM | TABLE_CELL);
    let named = |names: &[&str]| f.action_names.iter().any(|a| names.iter().any(|n| a.eq_ignore_ascii_case(n)));
    let activate = named(&["click", "press", "activate", "toggle", "check", "uncheck", "select", "jump", "push", "invoke"]);
    let expand = named(&["expand or contract", "expand", "open", "popup", "menu", "showmenu", "show menu"]);
    if activate && !item {
        out.push("AXPress");
    }
    if (f.expandable || expand) && !activate && !item && (matches!(ax_role, "AXMenuItem" | "AXMenuBarItem" | "AXMenuButton" | "AXPopUpButton") || f.role == TREE_ITEM) {
        out.push("AXPress");
    }
    if named(&["menu", "showmenu", "show menu", "popup"]) || (f.has_popup && matches!(ax_role, "AXMenuButton" | "AXPopUpButton")) {
        out.push("AXShowMenu");
    }
    if activate && item {
        out.push("AXOpen");
    }
    if f.has_value && !f.value_read_only && matches!(f.role, SLIDER | SPIN_BUTTON | DIAL) {
        out.push("AXIncrement");
        out.push("AXDecrement");
    }
    if f.top_level && matches!(ax_role, "AXWindow") {
        out.push("AXRaise");
    }
    let mut seen = Vec::new();
    for a in out {
        if !seen.contains(&a) {
            seen.push(a);
        }
    }
    seen.into_iter().map(str::to_string).collect()
}

/// Whether the value is settable (text inputs and sliders).
pub fn value_settable(f: &AtspiFacts) -> bool {
    (f.has_editable_text && f.editable && f.role != role::PASSWORD_TEXT)
        || (f.has_value && !f.value_read_only && matches!(f.role, role::SLIDER | role::SPIN_BUTTON | role::DIAL))
}

/// Formats a number like `NSNumber.stringValue` (integers without a fraction).
pub fn number_string(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(role: u32) -> AtspiFacts {
        AtspiFacts { role, ..Default::default() }
    }

    #[test]
    fn maps_common_controls() {
        assert_eq!(map_role(&f(role::PUSH_BUTTON)).role, "AXButton");
        assert_eq!(map_role(&AtspiFacts { checkable: true, ..f(role::PUSH_BUTTON) }), m("AXCheckBox", Some("AXToggle")));
        assert_eq!(map_role(&f(role::PASSWORD_TEXT)), m("AXTextField", Some("AXSecureTextField")));
        assert!(is_password(role::PASSWORD_TEXT) && !is_password(role::ENTRY));
        assert_eq!(map_role(&AtspiFacts { multi_line: true, editable: true, ..f(role::TEXT) }).role, "AXTextArea");
        assert_eq!(map_role(&AtspiFacts { editable: true, ..f(role::ENTRY) }).role, "AXTextField");
        assert_eq!(map_role(&AtspiFacts { identifier: "search-entry".into(), ..f(role::ENTRY) }), m("AXTextField", Some("AXSearchField")));
        assert_eq!(map_role(&AtspiFacts { editable: true, ..f(role::COMBO_BOX) }).role, "AXComboBox");
        assert_eq!(map_role(&f(role::COMBO_BOX)).role, "AXPopUpButton");
        assert_eq!(map_role(&f(role::DOCUMENT_WEB)).role, "AXWebArea");
        assert_eq!(map_role(&AtspiFacts { parent_role: Some(role::MENU_BAR), ..f(role::MENU_ITEM) }).role, "AXMenuBarItem");
        assert_eq!(map_role(&f(role::MENU_ITEM)).role, "AXMenuItem");
        assert_eq!(map_role(&f(role::TREE_ITEM)), m("AXRow", Some("AXOutlineRow")));
        assert_eq!(map_role(&f(role::PAGE_TAB)), m("AXRadioButton", Some("AXTabButton")));
        assert!(map_role(&f(role::LABEL)).name_is_value);
        assert!(map_role(&f(role::TITLE_BAR)).drop_name);
        assert_eq!(map_role(&AtspiFacts { top_level: true, ..f(role::FRAME) }), m("AXWindow", Some("AXStandardWindow")));
        assert_eq!(map_role(&AtspiFacts { top_level: true, ..f(role::DIALOG) }), m("AXWindow", Some("AXDialog")));
        assert_eq!(map_role(&f(9999)).role, "AXUnknown");
        assert_eq!(map_role(&f(role::SCROLL_BAR)).role, "AXScrollBar");
        assert_eq!(map_role(&f(role::SLIDER)).role, "AXSlider");
    }

    #[test]
    fn role_names_match_the_mac_vocabulary() {
        use crate::snapshot::text::role_name;
        let name = |x: &AtspiFacts| {
            let r = map_role(x);
            role_name(r.role, r.subrole)
        };
        assert_eq!(name(&f(role::PASSWORD_TEXT)), "textfield:secureTextField");
        assert_eq!(name(&f(role::LABEL)), "text");
        assert_eq!(name(&AtspiFacts { parent_role: Some(role::MENU_BAR), ..f(role::MENU_ITEM) }), "menubaritem");
        assert_eq!(name(&f(role::TREE_ITEM)), "row:outlineRow");
    }

    #[test]
    fn actions_from_the_action_interface() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let b = AtspiFacts { action_names: names(&["click"]), ..f(role::PUSH_BUTTON) };
        assert_eq!(actions(&b, "AXButton"), vec!["AXPress"]);
        let item = AtspiFacts { action_names: names(&["activate"]), ..f(role::LIST_ITEM) };
        assert_eq!(actions(&item, "AXRow"), vec!["AXOpen"]);
        let slider = AtspiFacts { has_value: true, ..f(role::SLIDER) };
        assert_eq!(actions(&slider, "AXSlider"), vec!["AXIncrement", "AXDecrement"]);
        let ro = AtspiFacts { has_value: true, value_read_only: true, ..f(role::SLIDER) };
        assert!(actions(&ro, "AXSlider").is_empty());
        let menu = AtspiFacts { action_names: names(&["click"]), ..f(role::MENU_ITEM) };
        assert_eq!(actions(&menu, "AXMenuItem"), vec!["AXPress"]);
        let win = AtspiFacts { top_level: true, ..f(role::FRAME) };
        assert_eq!(actions(&win, "AXWindow"), vec!["AXRaise"]);
        assert!(actions(&f(role::LABEL), "AXStaticText").is_empty());
        assert!(value_settable(&AtspiFacts { has_editable_text: true, editable: true, ..f(role::ENTRY) }));
        assert!(!value_settable(&AtspiFacts { has_editable_text: true, editable: true, ..f(role::PASSWORD_TEXT) }));
        assert!(!value_settable(&AtspiFacts { has_editable_text: true, ..f(role::ENTRY) }));
    }

    #[test]
    fn numbers_format_like_nsnumber() {
        assert_eq!(number_string(50.0), "50");
        assert_eq!(number_string(0.5), "0.5");
        assert_eq!(number_string(-3.0), "-3");
    }

    /// The numbers above are the installed header's, in order (Linux only; skipped without it).
    #[test]
    fn role_numbers_match_the_atspi_header() {
        let Some(path) = ["/usr/include/at-spi-2.0/atspi/atspi-constants.h"].into_iter().find(|p| std::path::Path::new(p).exists()) else {
            return;
        };
        let text = std::fs::read_to_string(path).unwrap();
        let start = text.find("ATSPI_ROLE_INVALID").unwrap() - 4;
        let end = text[start..].find("AtspiRole;").unwrap() + start;
        let names: Vec<&str> = text[start..end]
            .lines()
            .map(str::trim)
            .filter_map(|l| l.strip_prefix("ATSPI_ROLE_"))
            .map(|l| l.split(|c: char| !(c.is_ascii_uppercase() || c == '_' || c.is_ascii_digit())).next().unwrap_or(""))
            .filter(|w| *w != "LAST_DEFINED")
            .collect();
        let at = |n: &str| names.iter().position(|x| *x == n).unwrap() as u32;
        assert_eq!(at("PASSWORD_TEXT"), role::PASSWORD_TEXT);
        assert_eq!(at("PUSH_BUTTON"), role::PUSH_BUTTON);
        assert_eq!(at("ENTRY"), role::ENTRY);
        assert_eq!(at("FRAME"), role::FRAME);
        assert_eq!(at("MENU_ITEM"), role::MENU_ITEM);
        assert_eq!(at("TREE_ITEM"), role::TREE_ITEM);
        assert_eq!(at("DOCUMENT_WEB"), role::DOCUMENT_WEB);
        assert_eq!(at("PUSH_BUTTON_MENU"), role::PUSH_BUTTON_MENU);
        assert_eq!(at("TITLE_BAR"), role::TITLE_BAR);
        assert_eq!(at("APPLICATION"), role::APPLICATION);
    }
}
