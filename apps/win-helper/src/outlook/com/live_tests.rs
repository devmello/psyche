//! Live checks against classic Outlook (`cargo test -- --ignored live_outlook`). They skip when
//! classic Outlook is not installed. Everything happens in folders the test creates ("Psyche
//! live test …" under the default Calendar and Tasks) or on items the test created itself (one
//! contact, one draft to an `.invalid` address); nothing is ever sent, and the user's existing
//! items are never read for content or changed. Cleanup moves what the test made to Deleted
//! Items (never a permanent delete).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use super::dispatch::Var;
use super::live::{FOLDER_CALENDAR, FOLDER_TASKS, LiveOutlook, T_WRITE};
use crate::node::encoding::{hex, random_bytes};
use crate::node::log::HelperLog;
use crate::node::paths::Env;
use crate::node::time::parse_iso8601_millis;
use crate::outlook::OutlookState;
use crate::outlook::availability::detect;
use crate::outlook::backend::OutlookBackend;
use crate::outlook::ids::{FolderId, ItemId};
use crate::outlook::model::{
    ContactWrite, EventWrite, LabeledValue, MailDraft, RecurrenceSpec, TaskWrite,
};

fn live() -> Option<LiveOutlook> {
    let availability = detect(&Env::current());
    if !availability.available() {
        eprintln!(
            "classic Outlook is not installed ({:?}): live test skipped",
            availability.reason()
        );
        return None;
    }
    Some(LiveOutlook::new(
        HelperLog::quiet(),
        Arc::new(OutlookState {
            availability,
            trusted: Mutex::new(None),
        }),
    ))
}

fn ms(s: &str) -> i64 {
    parse_iso8601_millis(s).unwrap()
}

/// A day well in the future, so no real appointment shares the window.
const DAY: &str = "2031-03-04";

fn at(time: &str) -> i64 {
    ms(&format!("{DAY}T{time}Z"))
}

fn delete_item(o: &LiveOutlook, id: &str) {
    let id = ItemId::decode(id, "id").unwrap();
    let _ = o.job("test.cleanup", T_WRITE, move |s| {
        s.item(&id)?.call("Delete", vec![]).map(|_| ())
    });
}

#[test]
#[ignore]
fn live_outlook_round_trip() {
    let Some(o) = live() else { return };
    let name = format!("Psyche live test {}", hex(&random_bytes::<4>()));
    let n2 = name.clone();
    let (cal, list) = o
        .job("test.setup", T_WRITE, move |s| {
            let mk = |parent: i32,
                      kind: i32,
                      s: &mut super::live::Session|
             -> super::dispatch::CR<FolderId> {
                let f = s
                    .default_folder(parent)?
                    .obj("Folders", "Folders")?
                    .call_obj("Add", vec![Var::str(&n2), Var::int(kind)], "Folder")?;
                Ok(FolderId::new(&f.string("StoreID")?, &f.string("EntryID")?))
            };
            Ok((
                mk(FOLDER_CALENDAR, FOLDER_CALENDAR, s)?,
                mk(FOLDER_TASKS, FOLDER_TASKS, s)?,
            ))
        })
        .expect("create the test folders");

    let mut made: Vec<String> = Vec::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Calendar: the folder lists, an event round-trips with UTC times, updates, deletes.
        assert!(o.calendars().unwrap().iter().any(|c| c.id == cal.encode()));
        let ev = o
            .create_event(&EventWrite {
                calendar: Some(cal.clone()),
                title: Some("Psyche test event".into()),
                start: Some(at("14:00:00")),
                end: Some(at("15:30:00")),
                busy: Some(false),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(ev.start, format!("{DAY}T14:00:00Z"));
        assert_eq!(ev.end, format!("{DAY}T15:30:00Z"));
        assert_eq!(ev.availability.as_deref(), Some("free"));
        let id = ItemId::decode(&ev.id, "id").unwrap();
        let listed = o
            .events(
                at("00:00:00"),
                at("23:59:00"),
                Some(std::slice::from_ref(&cal)),
            )
            .unwrap();
        assert_eq!(listed.len(), 1);
        let up = o
            .update_event(
                &id,
                &EventWrite {
                    title: Some("Psyche test event (moved)".into()),
                    start: Some(at("16:00:00")),
                    end: Some(at("17:00:00")),
                    ..Default::default()
                },
                false,
            )
            .unwrap();
        assert_eq!(up.start, format!("{DAY}T16:00:00Z"));
        o.delete_event(&id, false).unwrap();
        assert!(
            o.events(
                at("00:00:00"),
                at("23:59:00"),
                Some(std::slice::from_ref(&cal))
            )
            .unwrap()
            .is_empty()
        );

        // A weekly series of three expands into occurrences; one occurrence deletes alone.
        let series = o
            .create_event(&EventWrite {
                calendar: Some(cal.clone()),
                title: Some("Psyche test series".into()),
                start: Some(at("09:00:00")),
                end: Some(at("09:30:00")),
                recurrence: Some(Some(RecurrenceSpec {
                    frequency: "weekly".into(),
                    count: Some(3),
                    ..Default::default()
                })),
                ..Default::default()
            })
            .unwrap();
        assert!(series.recurring);
        let window_end = at("00:00:00") + 30 * 86_400_000;
        let occ = o
            .events(at("00:00:00"), window_end, Some(std::slice::from_ref(&cal)))
            .unwrap();
        assert_eq!(occ.len(), 3, "{occ:?}");
        let second = ItemId::decode(&occ[1].id, "id").unwrap();
        assert!(second.occurrence.is_some());
        o.delete_event(&second, false).unwrap();
        assert_eq!(
            o.events(at("00:00:00"), window_end, Some(std::slice::from_ref(&cal)))
                .unwrap()
                .len(),
            2
        );
        o.delete_event(&ItemId::decode(&series.id, "id").unwrap().series(), false)
            .unwrap();

        // calendar.watch hears a change in the test calendar.
        let (tx, rx) = std::sync::mpsc::channel();
        let watch = o.watch_calendars(Arc::new(move || {
            let _ = tx.send(());
        }));
        if let Ok(handle) = watch {
            let e = o
                .create_event(&EventWrite {
                    calendar: Some(cal.clone()),
                    title: Some("Psyche watch".into()),
                    start: Some(at("11:00:00")),
                    end: Some(at("11:15:00")),
                    ..Default::default()
                })
                .unwrap();
            assert!(
                rx.recv_timeout(Duration::from_secs(15)).is_ok(),
                "an Items event arrived"
            );
            drop(handle);
            o.delete_event(&ItemId::decode(&e.id, "id").unwrap(), false)
                .unwrap();
        }

        // Tasks: create with a due date, list, update, complete, flag, delete.
        let t = o
            .create_task(&TaskWrite {
                list: Some(list.clone()),
                title: Some("Psyche test task".into()),
                due: Some(Some(at("12:00:00"))),
                priority: Some(1),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.priority, 1);
        assert!(t.due.is_some());
        let tid = ItemId::decode(&t.id, "id").unwrap();
        assert!(
            o.tasks(Some(std::slice::from_ref(&list)), Some(false))
                .unwrap()
                .iter()
                .any(|r| r.id == t.id)
        );
        o.update_task(
            &tid,
            &TaskWrite {
                title: Some("Psyche test task 2".into()),
                due: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(o.set_task_completed(&tid, true).unwrap().completed);
        o.set_task_flagged(&tid, true).unwrap();
        assert_eq!(
            o.tasks(Some(std::slice::from_ref(&list)), None).unwrap()[0].flagged,
            Some(true)
        );
        o.delete_task(&tid).unwrap();

        // Contacts (needs Outlook to trust the helper: skipped behind the object model guard).
        match o.create_contact(&ContactWrite {
            given_name: Some("Psyche".into()),
            family_name: Some("Live Test".into()),
            birthday: Some((None, 7, 4)),
            emails: vec![LabeledValue {
                label: String::new(),
                value: "psyche-live-test@example.invalid".into(),
            }],
            ..Default::default()
        }) {
            Ok(c) => {
                made.push(c.id.clone());
                assert_eq!(c.birthday.as_deref(), Some("--07-04"));
                let cid = ItemId::decode(&c.id, "id").unwrap();
                let u = o
                    .update_contact(
                        &cid,
                        &ContactWrite {
                            job_title: Some("Tester".into()),
                            phones: vec![LabeledValue {
                                label: "work".into(),
                                value: "+1 555 0100".into(),
                            }],
                            ..Default::default()
                        },
                    )
                    .unwrap();
                assert_eq!(u.job_title, "Tester");
                assert_eq!(o.read_contact(&cid).unwrap().phones[0].label, "work");
            }
            Err(e) => assert_eq!(e.reason, "outlook_object_model_guard", "{e}"),
        }

        // A draft to an .invalid address: saved, read back with its hash, never sent.
        match o.save_draft(&MailDraft {
            to: vec!["nobody@example.invalid".into()],
            cc: None,
            subject: "Psyche live test draft".into(),
            body: "Not sent.".into(),
        }) {
            Ok(d) => {
                made.push(d.draft_id.clone());
                let again = o
                    .draft(&ItemId::decode(&d.draft_id, "id").unwrap())
                    .unwrap()
                    .unwrap();
                assert_eq!(again.body_sha256, d.body_sha256);
                assert_eq!(again.to, vec!["nobody@example.invalid".to_string()]);
            }
            Err(e) => assert_eq!(e.reason, "outlook_object_model_guard", "{e}"),
        }
    }));

    for id in &made {
        delete_item(&o, id);
    }
    let _ = o.job("test.cleanup", T_WRITE, move |s| {
        for f in [&cal, &list] {
            s.folder(f)?.call("Delete", vec![])?;
        }
        Ok(())
    });
    if let Err(p) = result {
        std::panic::resume_unwind(p);
    }
    let _ = name;
}

#[test]
#[ignore]
fn live_outlook_reads_are_bounded() {
    let Some(o) = live() else { return };
    // Mailboxes and calendars list without content; a search answers within its budget.
    let t = std::time::Instant::now();
    let _ = o.mailboxes(None).unwrap();
    let _ = o.calendars().unwrap();
    let r = o
        .search_mail(&Default::default(), &Default::default(), 5)
        .unwrap();
    assert!(r.messages.len() <= 5);
    assert!(t.elapsed() < Duration::from_secs(55));
    // mail.selected never starts Outlook and never fails for an empty selection.
    let _ = o.selected_mail(5).unwrap();
}
