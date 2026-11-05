//! The Outlook capability layer over the fake backend: manifest parity with the mac helper,
//! parameter validation, shapes, receipts, approval and binding rules, error pass-through.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use super::caps::Ctx;
use super::dates::tests::eastern;
use super::fake::{Fake, folder, id, ms};
use super::mail::body_hash;
use crate::node::capability::{CapResult, ErrorCode};
use crate::node::paths::Env;
use crate::node::{CapabilityRegistry, InvocationContext, Runtime};

fn fixed_now() -> i64 {
    1_793_890_800_000 // 2026-11-05T15:00:00Z
}

struct H {
    reg: CapabilityRegistry,
    fake: Arc<Fake>,
    rt: tokio::runtime::Runtime,
    home: PathBuf,
}

impl Drop for H {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn h() -> H {
    let home = std::env::temp_dir().join(format!(
        "psyche-outlook-test-{}",
        crate::node::encoding::hex(&crate::node::encoding::random_bytes::<8>())
    ));
    std::fs::create_dir_all(&home).unwrap();
    let env = Env::default()
        .with("PSYCHE_HOME", home.display().to_string())
        .with("USERPROFILE", home.display().to_string());
    let runtime = Runtime::offline(env.clone());
    let fake = Fake::seeded();
    let mut reg = CapabilityRegistry::new(runtime.clone());
    super::register_with(
        &mut reg,
        &Ctx {
            backend: fake.clone(),
            zone: Arc::new(eastern()),
            env,
            home: runtime.home.clone(),
            debounce: Duration::from_millis(150),
            now: fixed_now,
        },
    );
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap();
    H {
        reg,
        fake,
        rt,
        home: runtime.home.clone(),
    }
}

impl H {
    fn run(&self, ctx: InvocationContext) -> CapResult {
        let cap = self
            .reg
            .get(&ctx.capability)
            .unwrap_or_else(|| panic!("no {}", ctx.capability));
        self.rt.block_on((cap.handler)(ctx))
    }

    fn call(&self, cap: &str, params: Value) -> CapResult {
        self.run(InvocationContext::detached(cap, params))
    }

    fn approved(&self, cap: &str, params: Value) -> CapResult {
        self.run(InvocationContext::new(
            "t",
            cap,
            params,
            Some("apr_1".into()),
            Arc::new(|_| {}),
        ))
    }

    fn ok(&self, cap: &str, params: Value) -> Value {
        self.call(cap, params)
            .unwrap_or_else(|e| panic!("{cap}: {e}"))
            .result
    }

    fn err(&self, cap: &str, params: Value) -> crate::node::CapabilityError {
        self.call(cap, params)
            .err()
            .unwrap_or_else(|| panic!("{cap} should fail"))
    }
}

fn invalid(e: &crate::node::CapabilityError, field: &str) {
    assert_eq!(e.code, ErrorCode::InvalidParams, "{e}");
    assert_eq!(e.details["field"], field, "{e}");
}

/// Name, side effect, target kind, receipt kind and required params of every capability, as the
/// mac helper declares them.
#[test]
fn manifest_matches_the_mac_helper() {
    let h = h();
    /// (name, side effect, target kind, receipt kind, required params)
    type Row<'a> = (
        &'a str,
        &'a str,
        Option<&'a str>,
        Option<&'a str>,
        &'a [&'a str],
    );
    let expect: &[Row] = &[
        ("calendar.list_calendars", "read", None, None, &[]),
        ("calendar.list_events", "read", None, None, &["from", "to"]),
        (
            "calendar.create_event",
            "write",
            None,
            Some("calendar_write"),
            &["end", "start", "title"],
        ),
        (
            "calendar.update_event",
            "write",
            None,
            Some("calendar_write"),
            &["id"],
        ),
        ("calendar.free_busy", "read", None, None, &["from", "to"]),
        (
            "calendar.delete_event",
            "destructive",
            None,
            Some("calendar_write"),
            &["id"],
        ),
        ("calendar.watch", "read", None, None, &[]),
        ("reminders.list_lists", "read", None, None, &[]),
        ("reminders.list", "read", None, None, &[]),
        (
            "reminders.create",
            "write",
            None,
            Some("connector_action"),
            &["title"],
        ),
        (
            "reminders.update",
            "write",
            None,
            Some("connector_action"),
            &["id"],
        ),
        (
            "reminders.complete",
            "write",
            None,
            Some("connector_action"),
            &[],
        ),
        (
            "reminders.delete",
            "destructive",
            None,
            Some("connector_action"),
            &["id"],
        ),
        (
            "reminders.set_flagged",
            "write",
            Some("app"),
            Some("connector_action"),
            &["flagged", "id"],
        ),
        ("mail.search", "read", None, None, &[]),
        ("mail.read", "read", None, None, &["id"]),
        (
            "mail.draft",
            "write",
            Some("recipient"),
            Some("email_draft"),
            &["body", "subject", "to"],
        ),
        (
            "mail.send",
            "write",
            Some("recipient"),
            Some("send_email"),
            &["body", "subject", "to"],
        ),
        ("mail.mailboxes", "read", None, None, &[]),
        ("mail.selected", "read", None, None, &[]),
        (
            "mail.reply_draft",
            "write",
            Some("recipient"),
            Some("email_draft"),
            &["body", "id"],
        ),
        (
            "mail.forward_draft",
            "write",
            Some("recipient"),
            Some("email_draft"),
            &["id", "to"],
        ),
        (
            "mail.send_draft",
            "write",
            Some("recipient"),
            Some("send_email"),
            &["bodySha256", "draftId", "subject", "to"],
        ),
        (
            "mail.set_flags",
            "write",
            Some("account"),
            Some("connector_action"),
            &["ids"],
        ),
        (
            "mail.move",
            "write",
            Some("account"),
            Some("connector_action"),
            &["ids", "to"],
        ),
        (
            "mail.save_attachments",
            "write",
            Some("path"),
            Some("connector_action"),
            &["id"],
        ),
        ("contacts.search", "read", None, None, &["query"]),
        ("contacts.read", "read", None, None, &["id"]),
        (
            "contacts.create",
            "write",
            None,
            Some("connector_action"),
            &[],
        ),
        (
            "contacts.update",
            "write",
            None,
            Some("connector_action"),
            &["id"],
        ),
        ("contacts.list", "read", None, None, &[]),
    ];
    assert_eq!(h.reg.len(), expect.len());
    for (name, side, target, receipt, required) in expect {
        let cap = h.reg.get(name).unwrap_or_else(|| panic!("missing {name}"));
        let m = cap.spec.manifest_entry();
        assert_eq!(m["sideEffect"], *side, "{name}");
        assert_eq!(
            m.get("targetKind").and_then(Value::as_str),
            *target,
            "{name}"
        );
        assert_eq!(cap.spec.receipt_kind.as_deref(), *receipt, "{name}");
        let req: Vec<&str> = m["inputSchema"]["required"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        assert_eq!(req, *required, "{name}");
        assert_eq!(m["streaming"], *name == "calendar.watch", "{name}");
    }
    let ev = h
        .reg
        .get("calendar.create_event")
        .unwrap()
        .spec
        .manifest_entry();
    let p = &ev["inputSchema"]["properties"];
    assert_eq!(p["title"], json!({"type": "string", "maxLength": 500.0}));
    assert_eq!(p["availability"]["enum"], json!(["busy", "free"]));
    assert_eq!(p["alarms"]["maxItems"], json!(5.0));
    let up = h
        .reg
        .get("calendar.update_event")
        .unwrap()
        .spec
        .manifest_entry();
    assert!(up["inputSchema"]["properties"].get("calendarId").is_none());
    assert_eq!(
        up["inputSchema"]["properties"]["span"]["enum"],
        json!(["this", "future"])
    );
}

// MARK: Calendar

#[test]
fn list_events_validates_windows_and_filters_exactly() {
    let h = h();
    invalid(
        &h.err(
            "calendar.list_events",
            json!({"from": "2026-11-05T00:00:00Z", "to": "2027-11-07T00:00:00Z"}),
        ),
        "to",
    );
    invalid(
        &h.err(
            "calendar.list_events",
            json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-05T00:00:00Z"}),
        ),
        "to",
    );
    invalid(
        &h.err(
            "calendar.list_events",
            json!({"from": "Nov 5", "to": "2026-11-06T00:00:00Z"}),
        ),
        "from",
    );
    invalid(&h.err("calendar.list_events", json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z", "calendarIds": ["x"]})), "calendarIds");
    invalid(
        &h.err(
            "calendar.list_events",
            json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z", "limit": 0}),
        ),
        "limit",
    );
    let v = h.ok("calendar.list_events", json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z", "calendarIds": [folder(1)]}));
    assert_eq!(v["provenance"], "untrusted");
    let titles: Vec<&str> = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        titles,
        ["Standup", "Lunch", "Review"],
        "December event outside the window dropped; start order"
    );
    let e = &v["events"][0];
    for k in ["location", "notes", "url", "conferenceUrl", "recurrence"] {
        assert!(
            e.as_object().unwrap().contains_key(k),
            "{k} is a required nullable key"
        );
    }
    let (from, to, cals) = h.fake.s.lock().unwrap().last_events_query.clone().unwrap();
    assert_eq!(
        (from, to),
        (ms("2026-11-05T00:00:00Z"), ms("2026-11-06T00:00:00Z"))
    );
    assert_eq!(cals.unwrap().len(), 1);
    let v = h.ok("calendar.list_events", json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z", "query": "REV", "limit": 5}));
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
    let v = h.ok(
        "calendar.list_events",
        json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z", "limit": 1}),
    );
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
}

#[test]
fn create_event_validates_and_writes_a_receipt() {
    let h = h();
    let base =
        json!({"title": "Dentist", "start": "2026-11-06T14:00:00Z", "end": "2026-11-06T15:00:00Z"});
    let with = |k: &str, v: Value| {
        let mut b = base.clone();
        b[k] = v;
        b
    };
    invalid(
        &h.err("calendar.create_event", with("title", json!("  "))),
        "title",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            with("end", json!("2026-11-06T13:00:00Z")),
        ),
        "end",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            with("availability", json!("tentative")),
        ),
        "availability",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            with("alarms", json!(vec![json!({"relativeMinutes": -1}); 6])),
        ),
        "alarms",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            with("alarms", json!([{"relativeMinutes": 10}])),
        ),
        "alarm",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            with("recurrence", json!({"frequency": "hourly"})),
        ),
        "recurrence",
    );
    invalid(
        &h.err("calendar.create_event", with("calendarId", json!("nope"))),
        "calendarId",
    );
    invalid(
        &h.err(
            "calendar.create_event",
            json!({"title": "x", "start": "2026-11-06T14:00:00Z"}),
        ),
        "end",
    );
    assert!(h.fake.calls().is_empty(), "nothing reached Outlook");
    let mut ok = with("alarms", json!([{"relativeMinutes": -15}]));
    ok["recurrence"] = json!({"frequency": "weekly", "daysOfWeek": ["mo"]});
    ok["availability"] = json!("free");
    ok["calendarId"] = json!(folder(1));
    let out = h.call("calendar.create_event", ok).unwrap();
    assert_eq!(out.result["event"]["title"], "Dentist");
    let r = out.receipt.unwrap();
    assert_eq!(r.summary, "Created event Dentist");
    assert_eq!(r.external_refs["eventId"], out.result["event"]["id"]);
    let (w, _) = h.fake.s.lock().unwrap().last_event_write.clone().unwrap();
    assert_eq!(w.busy, Some(false));
    assert_eq!(w.alarms, Some(vec![super::model::Alarm::Relative(-15)]));
    assert_eq!(w.start, Some(ms("2026-11-06T14:00:00Z")));
    assert!(w.calendar.is_some());
}

#[test]
fn update_and_delete_event() {
    let h = h();
    invalid(
        &h.err(
            "calendar.update_event",
            json!({"id": id(10), "span": "all"}),
        ),
        "span",
    );
    invalid(&h.err("calendar.update_event", json!({"id": "17"})), "id");
    let out = h
        .call(
            "calendar.update_event",
            json!({"id": id(10), "title": "Daily", "recurrence": null, "span": "future"}),
        )
        .unwrap();
    assert_eq!(out.result["event"]["title"], "Daily");
    assert_eq!(out.receipt.unwrap().summary, "Updated event Daily");
    let (w, future) = h.fake.s.lock().unwrap().last_event_write.clone().unwrap();
    assert!(future);
    assert_eq!(w.recurrence, Some(None), "null removes the recurrence");
    assert_eq!(w.calendar, None);
    let out = h
        .call("calendar.delete_event", json!({"id": id(11)}))
        .unwrap();
    assert_eq!(out.result, json!({"deleted": true}));
    assert_eq!(out.receipt.unwrap().external_refs["eventId"], id(11));
    h.ok(
        "calendar.delete_event",
        json!({"id": id(12), "span": "future"}),
    );
    assert!(h.fake.calls().contains(&"delete_event_future".to_string()));
    let e = h.err("calendar.delete_event", json!({"id": id(99)}));
    assert_eq!(e.reason, "event_not_found");
}

#[test]
fn free_busy_blocks() {
    let h = h();
    invalid(
        &h.err(
            "calendar.free_busy",
            json!({"from": "2026-11-01T00:00:00Z", "to": "2027-01-05T00:00:00Z"}),
        ),
        "to",
    );
    let v = h.ok(
        "calendar.free_busy",
        json!({"from": "2026-11-05T00:00:00Z", "to": "2026-11-06T00:00:00Z"}),
    );
    assert!(
        v.get("provenance").is_none(),
        "busy blocks carry no content"
    );
    let blocks = v["blocks"].as_array().unwrap();
    assert_eq!(blocks.len(), 2, "free lunch left out");
    assert_eq!(
        blocks[0],
        json!({"start": "2026-11-05T09:00:00Z", "end": "2026-11-05T09:15:00Z", "calendarId": folder(1), "availability": "busy"})
    );
    assert_eq!(blocks[1]["availability"], "tentative");
}

#[test]
fn watch_debounces_and_ends_with_the_count() {
    let h = h();
    let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
    let ev2 = events.clone();
    let ctx = InvocationContext::new(
        "w",
        "calendar.watch",
        json!({}),
        None,
        Arc::new(move |v| ev2.lock().unwrap().push(v)),
    );
    let cap = h.reg.get("calendar.watch").unwrap();
    let fake = h.fake.clone();
    let out = h.rt.block_on(async move {
        let task = tokio::spawn((cap.handler)(ctx));
        for _ in 0..50 {
            if fake.s.lock().unwrap().watch.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let cb = fake.s.lock().unwrap().watch.clone().unwrap();
        for _ in 0..3 {
            cb();
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        cb();
        tokio::time::sleep(Duration::from_millis(400)).await;
        // Outlook went away: the backend drops the callback, the stream ends.
        drop(cb);
        fake.s.lock().unwrap().watch = None;
        task.await.unwrap()
    });
    assert_eq!(out.unwrap().result, json!({"events": 2}));
    let evs = events.lock().unwrap();
    assert_eq!(evs.len(), 2);
    assert_eq!(
        evs[0],
        json!({"type": "calendar.changed", "at": "2026-11-05T15:00:00Z", "coalesced": 3})
    );
    assert_eq!(evs[1]["coalesced"], 1);
}

// MARK: Reminders

#[test]
fn reminders_list_filters_and_includes_flagged_mail() {
    let h = h();
    invalid(
        &h.err("reminders.list", json!({"dueBefore": "soon"})),
        "dueBefore",
    );
    invalid(&h.err("reminders.list", json!({"offset": -1})), "offset");
    let v = h.ok("reminders.list", json!({}));
    assert_eq!(v["provenance"], "untrusted");
    let ids: Vec<String> = v["reminders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap().to_owned())
        .collect();
    // Soonest due first, undated last.
    assert_eq!(ids, [id(23), id(20), id(21), id(22)]);
    let v = h.ok("reminders.list", json!({"overdue": true}));
    assert_eq!(
        h.fake.s.lock().unwrap().last_tasks_query.clone().unwrap().1,
        Some(false),
        "overdue asks for open ones"
    );
    let ids: Vec<&str> = v["reminders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [id(20).as_str(), id(21).as_str()]);
    let v = h.ok("reminders.list", json!({"flagged": true}));
    let rs = v["reminders"].as_array().unwrap();
    assert_eq!(rs.len(), 1);
    assert_eq!(rs[0]["title"], "Reply to Bob");
    let v = h.ok("reminders.list", json!({"dueToday": true}));
    assert_eq!(v["reminders"][0]["id"], id(21));
    let v = h.ok(
        "reminders.list",
        json!({"dueBefore": "2026-11-02T00:00:00Z", "completed": false}),
    );
    assert_eq!(v["reminders"].as_array().unwrap().len(), 1);
    let v = h.ok(
        "reminders.list",
        json!({"query": "MOM", "offset": 1, "limit": 1}),
    );
    assert_eq!(v["reminders"][0]["id"], id(22));
}

#[test]
fn reminders_create_update_complete_delete_flag() {
    let h = h();
    invalid(
        &h.err(
            "reminders.create",
            json!({"title": "x", "recurrence": {"frequency": "daily"}}),
        ),
        "recurrence",
    );
    invalid(
        &h.err("reminders.create", json!({"title": "x", "priority": 10})),
        "priority",
    );
    invalid(&h.err("reminders.create", json!({"title": ""})), "title");
    invalid(
        &h.err("reminders.create", json!({"title": "x", "alarm": {}})),
        "alarm",
    );
    let out = h.call("reminders.create", json!({"title": "Buy milk", "due": "2026-11-06T17:00:00Z", "priority": 1, "url": "message://x", "alarm": {"relativeMinutes": -30}})).unwrap();
    assert_eq!(
        out.receipt.as_ref().unwrap().summary,
        "Created reminder Buy milk"
    );
    let w = h.fake.s.lock().unwrap().last_task_write.clone().unwrap();
    assert_eq!(w.due, Some(Some(ms("2026-11-06T17:00:00Z"))));
    assert_eq!(w.alarm, Some(super::model::Alarm::Relative(-30)));
    assert_eq!(w.priority, Some(1));
    // update: null clears the due date.
    h.ok("reminders.update", json!({"id": id(20), "due": null}));
    assert_eq!(
        h.fake
            .s
            .lock()
            .unwrap()
            .last_task_write
            .clone()
            .unwrap()
            .due,
        Some(None)
    );
    // complete by title: ambiguous, missing, then found.
    let e = h.err("reminders.complete", json!({"title": "Call mom"}));
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::Conflict, "reminder_ambiguous")
    );
    assert_eq!(e.details["ids"].as_array().unwrap().len(), 2);
    assert_eq!(
        h.err("reminders.complete", json!({"title": "Nope"})).reason,
        "reminder_not_found"
    );
    invalid(&h.err("reminders.complete", json!({})), "id");
    let out = h
        .call("reminders.complete", json!({"title": "Pay rent"}))
        .unwrap();
    assert_eq!(out.result["reminder"]["completed"], true);
    assert_eq!(out.receipt.unwrap().summary, "Completed reminder Pay rent");
    let out = h
        .call(
            "reminders.complete",
            json!({"id": id(20), "completed": false}),
        )
        .unwrap();
    assert_eq!(out.receipt.unwrap().summary, "Reopened reminder Pay rent");
    let out = h
        .call(
            "reminders.set_flagged",
            json!({"id": id(21), "flagged": true}),
        )
        .unwrap();
    assert_eq!(out.result, json!({"flagged": true}));
    assert_eq!(out.receipt.unwrap().summary, "Flagged a reminder");
    let out = h.call("reminders.delete", json!({"id": id(22)})).unwrap();
    assert_eq!(out.result, json!({"deleted": true}));
    assert_eq!(out.receipt.unwrap().external_refs["reminderId"], id(22));
}

// MARK: Contacts

#[test]
fn contacts_search_read_create_update_list() {
    let h = h();
    invalid(&h.err("contacts.search", json!({"query": " "})), "query");
    let v = h.ok("contacts.search", json!({"query": "ann"}));
    assert_eq!(v["provenance"], "untrusted");
    assert_eq!(v["contacts"][0]["name"], "Ann Lee");
    assert!(
        h.ok("contacts.search", json!({"query": "zzz"}))["contacts"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let v = h.ok("contacts.read", json!({"id": id(40)}));
    assert_eq!(v["contact"]["birthday"], "--07-04");
    assert_eq!(v["provenance"], "untrusted");
    assert_eq!(
        h.err("contacts.read", json!({"id": id(41)})).reason,
        "contact_not_found"
    );
    invalid(
        &h.err("contacts.create", json!({"jobTitle": "CEO"})),
        "givenName",
    );
    invalid(
        &h.err(
            "contacts.create",
            json!({"givenName": "Bo", "birthday": "July 4"}),
        ),
        "birthday",
    );
    invalid(
        &h.err(
            "contacts.create",
            json!({"givenName": "Bo", "phones": [{"label": "mobile", "value": "call me"}]}),
        ),
        "phones",
    );
    let four: Vec<Value> = (0..4)
        .map(|i| json!({"label": "", "value": format!("b{i}@x.com")}))
        .collect();
    let e = h.err(
        "contacts.create",
        json!({"givenName": "Bo", "emails": four}),
    );
    invalid(&e, "emails");
    assert!(
        e.message.contains("3 email"),
        "Outlook's limit is explained"
    );
    let out = h.call("contacts.create", json!({"givenName": "Bo", "familyName": "Ray", "birthday": "1990-07-04", "emails": [{"label": "work", "value": "bo@x.com"}]})).unwrap();
    assert_eq!(out.result["contact"]["birthday"], "1990-07-04");
    assert_eq!(out.receipt.as_ref().unwrap().summary, "Added a contact");
    let out = h.call("contacts.update", json!({"id": id(40), "jobTitle": "CTO", "addEmails": [{"label": "", "value": "ann@y.com"}]})).unwrap();
    assert_eq!(out.result["contact"]["jobTitle"], "CTO");
    invalid(
        &h.err(
            "contacts.update",
            json!({"id": id(40), "addEmails": [{"label": "", "value": "nope"}]}),
        ),
        "addEmails",
    );
    let v = h.ok("contacts.list", json!({"limit": 1}));
    assert_eq!(v["total"], 2);
    assert_eq!(v["truncated"], true);
    assert_eq!(
        v["contacts"][0],
        json!({"id": id(40), "name": "Ann Lee", "organization": "Acme"})
    );
    invalid(
        &h.err("contacts.list", json!({"fields": ["phone"]})),
        "fields",
    );
}

// MARK: Mail

#[test]
fn mail_search_and_read_shapes() {
    let h = h();
    invalid(
        &h.err("mail.search", json!({"account": "ann@x.com"})),
        "mailbox",
    );
    invalid(
        &h.err(
            "mail.search",
            json!({"since": "2026-11-05T00:00:00Z", "until": "2026-11-04T00:00:00Z"}),
        ),
        "until",
    );
    invalid(
        &h.err("mail.search", json!({"query": "x".repeat(201)})),
        "query",
    );
    let v = h.ok("mail.search", json!({"query": "lunch", "unread": true, "since": "2026-11-01T00:00:00Z", "mailbox": "Inbox", "account": "ann@x.com"}));
    assert_eq!(v["source"], "outlook");
    assert_eq!(v["truncated"], false);
    assert_eq!(v["provenance"], "untrusted");
    assert!(v.get("note").is_none());
    assert_eq!(v["messages"][0]["subject"], "Lunch?");
    let (f, scope, limit) = h.fake.s.lock().unwrap().last_search.clone().unwrap();
    assert_eq!(limit, 20, "mail.search defaults to 20");
    assert_eq!(f.unread, Some(true));
    assert_eq!(f.since, Some(ms("2026-11-01T00:00:00Z")));
    assert_eq!(scope.account.as_deref(), Some("ann@x.com"));
    let v = h.ok("mail.read", json!({"id": id(2), "maxLength": 100}));
    let m = &v["message"];
    assert_eq!(m["body"].as_str().unwrap().len(), 100);
    assert_eq!(m["truncated"], true);
    assert_eq!(m["cc"], json!(["cat@z.com"]));
    assert_eq!(
        m["attachments"][0],
        json!({"name": "bill.pdf", "size": 3, "mimeType": "application/pdf"})
    );
    assert_eq!(m["attachments"][1]["mimeType"], Value::Null);
    assert_eq!(v["provenance"], "untrusted");
    invalid(&h.err("mail.read", json!({"id": "42"})), "id");
    let v = h.ok("mail.mailboxes", json!({}));
    assert_eq!(
        v["mailboxes"][0],
        json!({"account": "ann@x.com", "name": "Inbox", "unreadCount": 2, "special": "inbox"})
    );
    assert_eq!(
        h.ok("mail.selected", json!({"limit": 500}))["messages"],
        json!([])
    );
}

#[test]
fn sending_always_needs_an_approval() {
    let h = h();
    let d = json!({"to": ["bob@y.com"], "cc": ["c@z.com"], "subject": "Hi", "body": "Hello"});
    let e = h.err("mail.send", d.clone());
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::ApprovalRequired, "send_needs_approval")
    );
    assert!(!h.fake.calls().contains(&"send_mail".to_string()));
    let out = h.approved("mail.send", d).unwrap();
    assert_eq!(out.result, json!({"sent": true}));
    let r = out.receipt.unwrap();
    assert_eq!(r.summary, "Sent an email to 1 recipient(s)");
    assert_eq!(r.external_refs["recipients"], 2);
    invalid(
        &h.err(
            "mail.draft",
            json!({"to": ["a@x.com, b@x.com"], "subject": "s", "body": "b"}),
        ),
        "to",
    );
    invalid(
        &h.err("mail.draft", json!({"to": [], "subject": "s", "body": "b"})),
        "to",
    );
}

#[test]
fn drafts_bind_to_what_was_approved() {
    let h = h();
    let out = h
        .call(
            "mail.draft",
            json!({"to": ["bob@y.com"], "subject": "Hi", "body": "Hello\n"}),
        )
        .unwrap();
    assert_eq!(out.result["saved"], true);
    assert_eq!(
        out.receipt.unwrap().summary,
        "Saved a draft to 1 recipient(s)"
    );
    let draft = out.result["draft"].clone();
    assert_eq!(draft["bodySha256"], body_hash("Hello"));
    let send = json!({"draftId": draft["draftId"], "to": ["BOB@y.com"], "subject": "Hi", "bodySha256": draft["bodySha256"]});
    let e = h.err("mail.send_draft", send.clone());
    assert_eq!(e.code, ErrorCode::ApprovalRequired);
    let mut changed = send.clone();
    changed["subject"] = json!("Hey");
    let e = h.approved("mail.send_draft", changed).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::BindingMismatch, "draft_changed")
    );
    assert_eq!(e.details["changed"], json!(["subject"]));
    let out = h.approved("mail.send_draft", send.clone()).unwrap();
    assert_eq!(out.result, json!({"sent": true}));
    assert_eq!(out.receipt.unwrap().external_refs["recipients"], 1);
    // Sent: the draft is gone.
    let e = h.approved("mail.send_draft", send).unwrap_err();
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::NotFound, "draft_not_open")
    );
    invalid(
        &h.approved(
            "mail.send_draft",
            json!({"draftId": "7", "to": ["a@x.com"], "subject": "s", "bodySha256": "x"}),
        )
        .unwrap_err(),
        "draftId",
    );
    // Reply and forward drafts.
    let out = h
        .call(
            "mail.reply_draft",
            json!({"id": id(2), "body": "Sure", "replyAll": true}),
        )
        .unwrap();
    assert_eq!(out.result["draft"]["to"], json!(["bob@y.com", "cat@z.com"]));
    assert_eq!(
        out.receipt.unwrap().summary,
        "Saved a reply draft to 2 recipient(s)"
    );
    invalid(
        &h.err("mail.forward_draft", json!({"id": id(2), "to": []})),
        "to",
    );
    let out = h
        .call(
            "mail.forward_draft",
            json!({"id": id(1), "to": ["acct@z.com"], "body": "FYI"}),
        )
        .unwrap();
    assert_eq!(out.result["draft"]["subject"], "FW: Invoice");
}

#[test]
fn flags_and_moves() {
    let h = h();
    invalid(&h.err("mail.set_flags", json!({"ids": [id(1)]})), "read");
    invalid(
        &h.err("mail.set_flags", json!({"ids": [id(1)], "flagColor": 7})),
        "flagColor",
    );
    invalid(
        &h.err(
            "mail.set_flags",
            json!({"ids": [id(1)], "flagColor": 2, "flagged": false}),
        ),
        "flagColor",
    );
    invalid(&h.err("mail.set_flags", json!({"ids": []})), "ids");
    let out = h
        .call(
            "mail.set_flags",
            json!({"ids": [id(1), id(1), id(2)], "read": true, "flagColor": 3}),
        )
        .unwrap();
    assert_eq!(out.result, json!({"updated": 2}), "duplicates dropped");
    assert_eq!(out.receipt.unwrap().summary, "Updated 2 message(s)");
    let f = h.fake.s.lock().unwrap().last_flags.unwrap();
    assert_eq!((f.read, f.color), (Some(true), Some(3)));
    invalid(
        &h.err("mail.move", json!({"ids": [id(1)], "to": "trash"})),
        "to",
    );
    let out = h
        .call(
            "mail.move",
            json!({"ids": [id(1)], "to": {"mailbox": "Receipts", "account": "ann@x.com"}}),
        )
        .unwrap();
    assert_eq!(out.result, json!({"moved": 1}));
    assert_eq!(
        h.fake.s.lock().unwrap().last_move,
        Some(super::model::Destination::Mailbox {
            name: "Receipts".into(),
            account: "ann@x.com".into()
        })
    );
    h.ok("mail.move", json!({"ids": [id(1)], "to": "archive"}));
}

#[test]
fn attachments_save_to_staging_or_granted_folders() {
    let h = h();
    let out = h
        .call("mail.save_attachments", json!({"id": id(1)}))
        .unwrap();
    assert_eq!(out.result["library"], true);
    assert_eq!(out.result["provenance"], "untrusted");
    let files = out.result["files"].as_array().unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0]["path"], Value::Null);
    assert_eq!(files[0]["libraryItemId"], Value::Null);
    let staged = files[0]["stagedPath"].as_str().unwrap();
    assert!(staged.contains(r"helper\staging\mail-"), "{staged}");
    assert_eq!(std::fs::metadata(staged).unwrap().len(), 3);
    assert_eq!(files[0]["mimeType"], "application/pdf");
    assert!(files[1].get("mimeType").is_none());
    assert_eq!(out.receipt.unwrap().summary, "Saved 2 attachment(s)");
    // A folder outside the granted ones is refused; a granted one works, names deduplicated.
    let docs = h.home.join("Docs");
    std::fs::create_dir_all(&docs).unwrap();
    std::fs::write(docs.join("bill.pdf"), b"old").unwrap();
    let e = h.err(
        "mail.save_attachments",
        json!({"id": id(1), "folder": docs.display().to_string()}),
    );
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::PolicyDenied, "no_granted_folders")
    );
    std::fs::write(
        h.home.join("config.json"),
        json!({"permissions": {"folders": [{"path": docs.display().to_string()}]}}).to_string(),
    )
    .unwrap();
    let out = h
        .call(
            "mail.save_attachments",
            json!({"id": id(1), "folder": docs.display().to_string(), "names": ["bill.pdf"]}),
        )
        .unwrap();
    let f = &out.result["files"][0];
    assert_eq!(f["name"], "bill (2).pdf");
    assert!(f.get("stagedPath").is_none());
    assert!(f["path"].as_str().unwrap().ends_with("bill (2).pdf"));
    assert_eq!(out.result["library"], false);
    let e = h.err(
        "mail.save_attachments",
        json!({"id": id(1), "names": ["nope.txt"]}),
    );
    assert_eq!(e.reason, "no_attachments");
}

#[test]
fn backend_errors_pass_through_unchanged() {
    let h = h();
    h.fake.s.lock().unwrap().fail = Some(super::errors::object_model_guard());
    let e = h.err("mail.read", json!({"id": id(1)}));
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::Forbidden, "outlook_object_model_guard")
    );
    assert_eq!(e.details["permission"], "automation");
    h.fake.s.lock().unwrap().fail = Some(super::errors::timed_out());
    let e = h.err("calendar.list_calendars", json!({}));
    assert_eq!(
        (e.code, e.reason.as_str()),
        (ErrorCode::Timeout, "outlook_not_responding")
    );
    assert!(e.retryable);
}

#[test]
fn unavailable_outlook_advertises_nothing() {
    // With classic Outlook missing (as on this build machine), `register` adds no capability.
    let rt = Runtime::offline(Env::current());
    let state = super::state(&rt);
    let mut reg = CapabilityRegistry::new(rt.clone());
    super::register(&mut reg);
    if state.availability.available() {
        assert_eq!(reg.len(), 31);
    } else {
        assert!(reg.is_empty());
        let s = super::status_json(&rt);
        assert_eq!(s["available"], false);
        assert!(s["reason"].is_string());
    }
}
