//! U2: the bridge between the desktop's own question queue and the phone link — approvals (§8) and questions (§9).
//!
//! Three pure decisions live here, so they can be tested without a socket, a phone or a window:
//!
//! 1. **What to offer** (`plan`): only the HEAD of the queue (D10), only while it is still alive, and only what the
//!    phone can act on at all. Everything the hub holds that is no longer the head is resolved (D11) — that covers the
//!    island answering, the terminal answering, the producer cancelling, the queue moving on, and an item that expires
//!    before the transport had a chance to prune it.
//! 2. **How one item becomes an ask** (`ask_of`): a permission (the hook's `allow`/`deny`/`terminal` options) is an
//!    `approval` whose fingerprint hashes the WHOLE card text (D9); a questionnaire (`form`) is a `question`.
//! 3. **Where a phone's answer goes** (`Relay`): the two `Decisions` methods, matched by fingerprint against the head
//!    only, with a bounded wait so a stuck write can never stall the phone's own read task (§4 «SILENT»).
//!
//! Nothing here talks to a socket, a window or a hub: the queue is a trait the app implements over the transport, and
//! the hub is the caller's business.

use std::sync::Arc;
use std::time::Duration;

use super::asks::{self, Ask, Choice, Question};
use super::permission;
use super::server::{self, Decisions};
use super::source;
use crate::question::ItemAnswer;
use crate::transport_view::{FormItemView, PendingAskView};

/// What this desktop offers right now, as far as the queue is concerned (§6.0). `answers` is the one capability that
/// changes what may be offered: a question is only ever sent to a phone that can answer it. Approvals are v1 and need
/// no capability at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caps {
    pub answers: bool,
}

/// What to tell the phones now: at most one request to offer, and the fingerprints that are gone.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
    pub offer: Option<Ask>,
    /// Fingerprints the phone still holds that must be resolved, in the order the hub held them.
    pub resolve: Vec<String>,
}

/// The plan for this moment: `pending` is the desktop's queue (oldest first, so its head is the only decidable item),
/// `offered` is what the hub is holding for the phone now, and `now` is epoch milliseconds.
///
/// An expired head is resolved and nothing is offered for it: the phone must never be left holding a request the
/// desktop no longer accepts (§8.2/§9.4, D11 — the phone stops at 120 s, the desktop at the item's own 115 s).
pub fn plan(pending: &[PendingAskView], offered: &[String], now: u64, caps: Caps) -> Plan {
    let _ = (pending, offered, now, caps);
    todo!("D10/D11: the queue has not been read into a plan yet")
}

/// One pending item as the phone may see it, or `None` when it must not be told about it at all:
///
/// * an agent with no pill in the island's catalogue (`source::pill_of_agent`),
/// * an item that is neither a permission nor a questionnaire (a plain question, e.g. Codex's plan prompt),
/// * a questionnaire when this connection was not offered `answers`,
/// * a questionnaire that breaks the §9.1 limits (`Ask::question` refuses it, so it is never sent half-built).
pub fn ask_of(item: &PendingAskView, created_at: u64, caps: Caps) -> Option<Ask> {
    let _ = (item, created_at, caps);
    todo!("D10: the pending item has not been read into an ask yet")
}

/// Whether this item is a permission request: the hook's own option values are the only signal the frame carries
/// (`allow` and `deny`, plus `terminal` when the island could not show the whole request). A questionnaire is never a
/// permission, and an answer question's values (`o0`, `o1`…) are never these.
fn is_permission(item: &PendingAskView) -> bool {
    item.form.is_none() && item.options.iter().any(|o| matches!(o.value.as_str(), "allow" | "deny" | "terminal"))
}

/// One questionnaire item as a §9 question: the agent's own wording and labels, never translated or reordered.
fn question_of(item: &FormItemView) -> Question {
    let wording = if item.text.trim().is_empty() { item.header.clone() } else { item.text.clone() };
    Question {
        question: wording,
        multi_select: item.multi_select,
        options: item.options.iter().map(|o| Choice { label: o.label.clone(), description: o.description.clone() }).collect(),
    }
}

/// The desktop's own question queue, as the decision seam needs it. Every method here may write to the receiver's
/// socket, so `Relay` calls them on their own thread and never while the caller holds a transport guard.
pub trait Queue: Send + Sync {
    /// The pending requests, oldest first (read-only on the receiver: no prune, no write).
    fn pending(&self) -> Vec<PendingAskView>;
    /// Answer the option at `index` of a plain question (a permission's `allow`/`deny` are options like any other).
    fn answer(&self, id: &str, index: usize) -> Result<(), ()>;
    /// Close the card without an answer: what the island's own «Rechazar» does.
    fn decline(&self, id: &str) -> Result<(), ()>;
    /// Answer a questionnaire: one entry per question, in the order they were asked (§9.2).
    fn answer_form(&self, id: &str, answers: Vec<ItemAnswer>) -> Result<(), ()>;
}

/// How long a phone's decision may hold its own read task. The phone pings every 20 s and gives a link up as `SILENT`
/// when nothing answers (§4), so the write is waited for at most this long and never retried.
pub const WAIT: Duration = Duration::from_secs(2);

/// The `Decisions` seam over the desktop's queue (§8, §9).
///
/// A decision is matched against the HEAD of the queue only (D10: the phone was only ever shown the head), and only a
/// call the receiver really took is `Ok`: on `Err` the hub sends nothing, the request stays pending and decidable
/// (§8.3 «silence is never a confirmation»). A call that timed out may still complete later in the desktop; if it
/// does, the queue changes and the next sweep resolves the fingerprint on the phone (D11).
pub struct Relay<Q: Queue> {
    queue: Arc<Q>,
    caps: Caps,
    wait: Duration,
}

impl<Q: Queue + 'static> Relay<Q> {
    /// The app's relay: [`WAIT`] is the bound on one phone decision.
    pub fn new(queue: Arc<Q>, caps: Caps) -> Relay<Q> {
        Relay::with_wait(queue, caps, WAIT)
    }

    pub fn with_wait(queue: Arc<Q>, caps: Caps, wait: Duration) -> Relay<Q> {
        Relay { queue, caps, wait }
    }

    /// The head of the queue, when it is the request this fingerprint names. D10: the phone only ever holds the head,
    /// so any other fingerprint is a decision about a request it was never shown.
    fn head(&self, fingerprint: &str) -> Result<PendingAskView, ()> {
        let pending = self.queue.pending();
        let head = pending.first().ok_or(())?;
        if head.expires_at <= server::now_ms() {
            return Err(()); // §8.2: the desktop stops accepting at the item's own deadline
        }
        let ask = ask_of(head, 0, self.caps).ok_or(())?;
        (ask.fingerprint() == fingerprint).then(|| head.clone()).ok_or(())
    }

    /// One receiver call on its own short-lived thread, waited for at most `wait`. A timeout is `Err` and nothing else:
    /// the read task goes back to answering pings, and the hub confirms nothing.
    fn bounded(&self, call: impl FnOnce(&Q) -> Result<(), ()> + Send + 'static) -> Result<(), ()> {
        let queue = self.queue.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name("phone-decide".into())
            .spawn(move || {
                let _ = tx.send(call(&queue));
            });
        if spawned.is_err() {
            return Err(());
        }
        rx.recv_timeout(self.wait).unwrap_or(Err(()))
    }
}

impl<Q: Queue + 'static> Decisions for Relay<Q> {
    fn decide(&self, fingerprint: &str, allow: bool) -> Result<(), ()> {
        let head = self.head(fingerprint)?;
        // A question is answered, never decided (§6): the two messages do not stand in for each other.
        if !is_permission(&head) {
            return Err(());
        }
        // D12: an Allow is never applied to a request the island could not show in full. The phone hides the button;
        // a decision that arrives anyway (an older app, a forged frame) resolves nothing.
        if allow && permission::shown(&head.text).lossy {
            return Err(());
        }
        let id = head.id.clone();
        if allow {
            let index = head.options.iter().position(|o| o.value == "allow").ok_or(())?;
            self.bounded(move |queue| queue.answer(&id, index))
        } else {
            match head.options.iter().position(|o| o.value == "deny") {
                Some(index) => self.bounded(move |queue| queue.answer(&id, index)),
                // The island's lossy card offers `terminal` instead of `deny`: closing the card is the same act.
                None => self.bounded(move |queue| queue.decline(&id)),
            }
        }
    }

    fn answer(&self, fingerprint: &str, picks: Vec<Vec<String>>) -> Result<(), ()> {
        let head = self.head(fingerprint)?;
        let Some(form) = head.form.as_ref() else { return Err(()) };
        // §9.2 twice: the server refuses a shape that breaks the table, and the labels are matched again here because
        // only exact equality may pick an option.
        let questions: Vec<Question> = form.iter().map(question_of).collect();
        if !asks::valid_picks(&questions, &picks) {
            return Err(());
        }
        let answers = form_answers(form, &picks).ok_or(())?;
        let id = head.id.clone();
        self.bounded(move |queue| queue.answer_form(&id, answers))
    }
}

/// The labels the phone sent, as the receiver's own answers: one entry per question, in order. `None` if a label is
/// not one this question offered (never trimmed, never case-fixed).
fn form_answers(form: &[FormItemView], picks: &[Vec<String>]) -> Option<Vec<ItemAnswer>> {
    form.iter()
        .zip(picks)
        .map(|(item, chosen)| {
            let indexes = chosen
                .iter()
                .map(|label| item.options.iter().position(|o| &o.label == label))
                .collect::<Option<Vec<usize>>>()?;
            if item.multi_select {
                Some(ItemAnswer::Options { indexes, text: None })
            } else {
                (indexes.len() == 1).then(|| ItemAnswer::Option { index: indexes[0] })
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport_view::{PendingAskOptionView, QuestionOptionView};
    use std::sync::Mutex;

    /// A permission card exactly as the hook writes it and the island shows it.
    const CARD: &str = "Claude Code pide permiso para Bash: npm run build";
    const LOSSY_CARD: &str = "Claude Code pide permiso para Bash: rm -rf build (ruta sensible; detalles solo en la terminal; decidir en la terminal)";

    fn option(value: &str, label: &str) -> PendingAskOptionView {
        PendingAskOptionView { value: value.into(), label: label.into() }
    }

    /// One pending item: a permission with the hook's own options.
    fn permission_item(id: &str, text: &str, lossy: bool) -> PendingAskView {
        let options = if lossy {
            vec![option("deny", "Rechazar"), option("terminal", "Decidir en la terminal")]
        } else {
            vec![option("allow", "Aprobar una vez"), option("deny", "Rechazar")]
        };
        PendingAskView {
            id: id.into(),
            kind: crate::question::Kind::Question,
            agent: "claude-code".into(),
            session_id: "sess-1".into(),
            text: text.into(),
            options,
            form: None,
            multi_select: false,
            expires_at: 115_000,
        }
    }

    fn item(label: &str, multi: bool) -> FormItemView {
        FormItemView {
            header: "Pregunta".into(),
            text: label.into(),
            options: vec![
                QuestionOptionView { index: 0, label: "main".into(), description: String::new() },
                QuestionOptionView { index: 1, label: "develop".into(), description: String::new() },
            ],
            multi_select: multi,
            allow_free_text: false,
        }
    }

    fn question_item(id: &str) -> PendingAskView {
        PendingAskView {
            id: id.into(),
            kind: crate::question::Kind::Question,
            agent: "claude-code".into(),
            session_id: "sess-1".into(),
            text: "Claude Code pregunta: Which branch?".into(),
            options: Vec::new(),
            form: Some(vec![item("Which branch should I use?", false), item("Which checks?", true)]),
            multi_select: false,
            expires_at: 115_000,
        }
    }

    const BOTH: Caps = Caps { answers: true };
    const NO_ANSWERS: Caps = Caps { answers: false };

    /// A permission becomes an approval whose fingerprint hashes the WHOLE card (D9), cut or not.
    #[test]
    fn a_permission_is_an_approval_over_the_whole_card() {
        let ask = ask_of(&permission_item("item-1", CARD, false), 1_000, BOTH).unwrap();
        assert!(matches!(ask, Ask::Approval { .. }));
        assert_eq!(ask.pill_id(), "integration_claude");
        let Ask::Approval { tool, command, .. } = &ask else { unreachable!() };
        assert_eq!(tool, "Bash");
        assert_eq!(command, CARD, "the command hashed is the whole card, never the shown part");
        assert_eq!(
            ask.fingerprint(),
            asks::fingerprint("integration_claude", "sess-1", "Bash", CARD, "item-1"),
            "D9: pill, session, tool, the whole text, and the item id as the input key"
        );
        let line: serde_json::Value = serde_json::from_str(&ask.approval_line()).unwrap();
        assert!(line.get("truncated").is_none(), "a lossless request is not flagged");
        assert_eq!(line["tool"], "Bash");
        assert_eq!(line["command"], "npm run build", "what runs, without the card's own chrome");
    }

    /// D12: a lossy request is sent with `truncated: true`, which is what leaves Denegar as the phone's only tap.
    #[test]
    fn a_lossy_permission_is_flagged_for_the_phone() {
        let ask = ask_of(&permission_item("item-2", LOSSY_CARD, true), 1_000, BOTH).unwrap();
        let line: serde_json::Value = serde_json::from_str(&ask.approval_line()).unwrap();
        assert_eq!(line["truncated"], true);
        assert_eq!(line["command"], "rm -rf build");
        assert_eq!(line["fingerprint"], ask.fingerprint());
    }

    /// A questionnaire becomes a §9 question; it needs `answers`, and a broken one is never offered.
    #[test]
    fn a_questionnaire_is_a_question_only_with_answers() {
        let ask = ask_of(&question_item("item-3"), 1_000, BOTH).unwrap();
        let questions = ask.questions().unwrap();
        assert_eq!(questions.len(), 2);
        assert_eq!(questions[0].question, "Which branch should I use?");
        assert!(!questions[0].multi_select);
        assert!(questions[1].multi_select);
        assert_eq!(questions[1].options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(), vec!["main", "develop"]);
        assert_eq!(
            ask.fingerprint(),
            asks::fingerprint("integration_claude", "sess-1", asks::QUESTION_TOOL, &asks::questions_json(questions), "item-3")
        );
        assert!(ask_of(&question_item("item-3"), 1_000, NO_ANSWERS).is_none(), "§6.0: never without `answers`");

        // 1-4 questions, 1-8 options each: anything else is dropped whole (§9.1).
        let mut broken = question_item("item-4");
        broken.form = Some(Vec::new());
        assert!(ask_of(&broken, 1_000, BOTH).is_none(), "no questions");
        let mut five = question_item("item-5");
        five.form = Some((0..5).map(|i| item(&format!("q{i}"), false)).collect());
        assert!(ask_of(&five, 1_000, BOTH).is_none(), "five questions");
    }

    /// An item the phone can do nothing with is never offered, and it does not become an approval by accident.
    #[test]
    fn an_item_the_phone_cannot_act_on_is_never_offered() {
        // A plain question (Codex's plan prompt, a single AskUserQuestion): neither a permission nor a questionnaire.
        let mut plain = permission_item("item-6", "Codex te pregunta: ¿plan?", false);
        plain.options = vec![option("o0", "Sí"), option("o1", "No")];
        assert!(ask_of(&plain, 1_000, BOTH).is_none());

        // An agent the island draws no pill for: the phone is not told a pill id it cannot name.
        let mut pi = permission_item("item-7", CARD, false);
        pi.agent = "pi".into();
        assert!(ask_of(&pi, 1_000, BOTH).is_none());
        let mut copilot = permission_item("item-8", CARD, false);
        copilot.agent = "copilot-cli".into();
        assert!(ask_of(&copilot, 1_000, BOTH).is_none());

        // The four agents the island has pills for are mapped exactly as `sessions` maps its engine kinds.
        for (agent, pill) in [
            ("claude-code", "integration_claude"),
            ("codex", "agent_codex"),
            ("gemini", "agent_gemini"),
            ("opencode", "agent_opencode"),
        ] {
            let mut item = permission_item("item-9", CARD, false);
            item.agent = agent.into();
            assert_eq!(ask_of(&item, 1_000, BOTH).unwrap().pill_id(), pill, "{agent}");
        }
    }

    /// D10: only the head is offered, and the next one is offered once the head is gone.
    #[test]
    fn only_the_head_of_the_queue_is_offered() {
        let head = permission_item("item-1", CARD, false);
        let second = permission_item("item-2", "Claude Code pide permiso para Bash: make test", false);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();

        let empty = plan(&[head.clone(), second.clone()], &[], 50_000, BOTH);
        assert_eq!(empty.offer.as_ref().map(|a| a.fingerprint().to_owned()), Some(ask.fingerprint().to_owned()));
        assert!(empty.resolve.is_empty(), "nothing was offered before, so nothing is resolved");

        // Already offered and still the head: nothing at all happens (the hub keeps one sheet per fingerprint).
        let steady = plan(&[head.clone(), second.clone()], &[ask.fingerprint().to_owned()], 50_000, BOTH);
        assert!(steady.offer.is_none());
        assert!(steady.resolve.is_empty());

        // The head is gone: the phone is resolved and the second item becomes the offered one.
        let next = plan(&[second.clone()], &[ask.fingerprint().to_owned()], 50_000, BOTH);
        assert_eq!(next.resolve, vec![ask.fingerprint().to_owned()], "D11: the fingerprint leaves the phone");
        let second_ask = ask_of(&second, 50_000, BOTH).unwrap();
        assert_eq!(next.offer.as_ref().unwrap().fingerprint(), second_ask.fingerprint());
    }

    /// D11: an item that expires before the transport pruned it is resolved, and nothing replaces it.
    #[test]
    fn an_expired_head_is_resolved_and_never_replaced() {
        let head = permission_item("item-1", CARD, false);
        let off = asks::fingerprint("integration_claude", "sess-1", "Bash", CARD, "item-1");
        let expired = plan(&[head.clone()], &[off.clone()], head.expires_at, BOTH);
        assert_eq!(expired.resolve, vec![off.clone()], "115 s: the desktop stops accepting at its own deadline");
        assert!(expired.offer.is_none());
        assert!(plan(&[head], &[off], 114_999, BOTH).offer.is_some(), "one millisecond earlier it is still offered");
    }

    /// A request resolved on the island or in the terminal, or cancelled by the producer, leaves the phone.
    #[test]
    fn anything_no_longer_pending_is_resolved() {
        let mut cancelled = permission_item("item-1", CARD, false);
        cancelled.expires_at = 115_000;
        // The queue is empty: the producer cancelled, the island answered, or the terminal did.
        let gone = plan(&[], &[asks::fingerprint("integration_claude", "sess-1", "Bash", CARD, "item-1")], 50_000, BOTH);
        assert!(gone.offer.is_none());
        assert_eq!(gone.resolve.len(), 1);

        // A head nobody can offer (no pill for that agent) is not offered AND resolves whatever was offered before.
        let mut pi = permission_item("item-2", CARD, false);
        pi.agent = "pi".into();
        let previous = asks::fingerprint("integration_claude", "sess-1", "Bash", CARD, "item-1");
        let refused = plan(&[pi], &[previous.clone()], 50_000, BOTH);
        assert!(refused.offer.is_none(), "the phone is not shown a request it cannot act on");
        assert_eq!(refused.resolve, vec![previous], "and it is not left holding the previous one");
    }

    /// An item whose fingerprint the phone already holds is not offered twice, and a stale one is not kept.
    #[test]
    fn the_plan_is_idempotent_and_keeps_only_what_belongs_to_the_head() {
        let head = permission_item("item-1", CARD, false);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let stale = "0".repeat(64);
        let kept = plan(&[head], &[stale.clone(), ask.fingerprint().to_owned()], 50_000, BOTH);
        assert!(kept.offer.is_none(), "the head's own fingerprint is already there");
        assert_eq!(kept.resolve, vec![stale], "a fingerprint that is not the head's is not kept");
    }

    // ---- the decision seam -----------------------------------------------------------------------------------

    /// The queue the relay is tested against: it records what was asked of it and answers as told.
    #[derive(Default)]
    struct Fake {
        items: Mutex<Vec<PendingAskView>>,
        calls: Mutex<Vec<String>>,
        take: Mutex<bool>,
        delay: Mutex<Option<Duration>>,
    }

    impl Fake {
        fn with(items: Vec<PendingAskView>) -> Arc<Fake> {
            Arc::new(Fake { items: Mutex::new(items), ..Fake::default() })
        }
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl Queue for Fake {
        fn pending(&self) -> Vec<PendingAskView> {
            self.items.lock().unwrap().clone()
        }
        fn answer(&self, id: &str, index: usize) -> Result<(), ()> {
            self.calls.lock().unwrap().push(format!("answer {id} {index}"));
            self.settle()
        }
        fn decline(&self, id: &str) -> Result<(), ()> {
            self.calls.lock().unwrap().push(format!("decline {id}"));
            self.settle()
        }
        fn answer_form(&self, id: &str, answers: Vec<ItemAnswer>) -> Result<(), ()> {
            let shown = answers
                .iter()
                .map(|a| match a {
                    ItemAnswer::Option { index } => format!("{index}"),
                    ItemAnswer::Options { indexes, .. } => format!("{indexes:?}"),
                    ItemAnswer::Text { text } => text.clone(),
                })
                .collect::<Vec<_>>()
                .join(" | ");
            self.calls.lock().unwrap().push(format!("form {id} {shown}"));
            self.settle()
        }
    }

    impl Fake {
        fn settle(&self) -> Result<(), ()> {
            if let Some(delay) = *self.delay.lock().unwrap() {
                std::thread::sleep(delay);
            }
            if *self.take.lock().unwrap() { Ok(()) } else { Err(()) }
        }
    }

    fn fake(items: Vec<PendingAskView>) -> Arc<Fake> {
        let fake = Fake::with(items);
        *fake.take.lock().unwrap() = true;
        fake
    }

    #[test]
    fn allow_answers_the_allow_option_and_deny_the_deny_option() {
        let head = permission_item("item-1", CARD, false);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = fake(vec![head.clone()]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        assert_eq!(relay.decide(ask.fingerprint(), true), Ok(()));
        assert_eq!(relay.decide(ask.fingerprint(), false), Ok(()));
        assert_eq!(queue.calls(), vec!["answer item-1 0".to_string(), "answer item-1 1".to_string()]);
    }

    /// Without a `deny` option the card is closed the way the island closes it, never with `terminal`.
    #[test]
    fn deny_without_a_deny_option_declines_and_never_picks_the_terminal() {
        let mut head = permission_item("item-1", CARD, false);
        head.options = vec![option("terminal", "Decidir en la terminal")];
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = fake(vec![head]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        assert_eq!(relay.decide(ask.fingerprint(), false), Ok(()));
        assert_eq!(queue.calls(), vec!["decline item-1".to_string()]);

        // …and an Allow is refused outright: there is no allow option to apply it to.
        assert_eq!(relay.decide(ask.fingerprint(), true), Err(()));
        assert_eq!(queue.calls().len(), 1, "nothing was asked of the receiver");
    }

    /// D12: a lossy request is never allowed from the phone, and the refusal never reaches the receiver.
    #[test]
    fn a_lossy_request_is_never_allowed_from_the_phone() {
        let head = permission_item("item-1", LOSSY_CARD, true);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = fake(vec![head]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        assert_eq!(relay.decide(ask.fingerprint(), true), Err(()));
        assert!(queue.calls().is_empty(), "a refused Allow resolves nothing");
        assert_eq!(relay.decide(ask.fingerprint(), false), Ok(()), "Denegar is still the phone's");
        assert_eq!(queue.calls(), vec!["answer item-1 0".to_string()], "the deny option of the lossy set");
    }

    /// An unknown fingerprint, an expired head, a non-head request and a question fingerprint are all refused.
    #[test]
    fn only_the_head_and_only_its_own_fingerprint_are_decidable() {
        let head = permission_item("item-1", CARD, false);
        let second = permission_item("item-2", "Claude Code pide permiso para Bash: make", false);
        let head_ask = ask_of(&head, 1_000, BOTH).unwrap();
        let second_ask = ask_of(&second, 1_000, BOTH).unwrap();
        let queue = fake(vec![head.clone(), second]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));

        assert_eq!(relay.decide(&"a".repeat(64), true), Err(()), "an unknown fingerprint");
        assert_eq!(relay.decide(second_ask.fingerprint(), true), Err(()), "D10: the second item is not on the phone");
        assert_eq!(relay.answer(head_ask.fingerprint(), vec![vec!["main".into()]]), Err(()), "not a question");
        assert!(queue.calls().is_empty());

        // The head's own fingerprint, once it has expired, is refused too: the phone stops at 115 s.
        let queue = fake(vec![permission_item("item-1", CARD, false)]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        let expired = permission_item("item-1", CARD, false);
        let mut expired = expired;
        expired.expires_at = 1; // long gone by now
        let _ = queue.items.lock().unwrap().iter_mut().for_each(|i| i.expires_at = 1);
        let expired_ask = ask_of(&expired, 1_000, BOTH).unwrap();
        assert_eq!(relay.decide(expired_ask.fingerprint(), true), Err(()));
        assert!(queue.calls().is_empty());
    }

    /// A receiver that refuses is a refusal: nothing is confirmed for it.
    #[test]
    fn a_receiver_that_refuses_is_a_refusal() {
        let head = permission_item("item-1", CARD, false);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = Fake::with(vec![head]);
        *queue.take.lock().unwrap() = false;
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        assert_eq!(relay.decide(ask.fingerprint(), true), Err(()));
        assert_eq!(queue.calls().len(), 1, "the call was made and refused");
    }

    /// A write that does not come back in time is `Err`: the read task goes back to answering pings, nothing is
    /// confirmed, and the request stays pending (documented in `Relay`).
    #[test]
    fn a_stuck_receiver_times_out_instead_of_stalling_the_phone() {
        let head = permission_item("item-1", CARD, false);
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = fake(vec![head]);
        *queue.delay.lock().unwrap() = Some(Duration::from_millis(400));
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(20));
        let began = std::time::Instant::now();
        assert_eq!(relay.decide(ask.fingerprint(), true), Err(()));
        assert!(began.elapsed() < Duration::from_millis(350), "the bound is the relay's, not the receiver's");
        // The call itself still happened on its own thread: the receiver is not retried, and the item stays pending.
        assert_eq!(queue.pending().len(), 1);
    }

    /// A questionnaire's picks become one entry per question, in order, by exact label.
    #[test]
    fn the_picks_become_one_answer_per_question() {
        let head = question_item("item-1");
        let ask = ask_of(&head, 1_000, BOTH).unwrap();
        let queue = fake(vec![head]);
        let relay = Relay::with_wait(queue.clone(), BOTH, Duration::from_millis(50));
        assert_eq!(relay.answer(ask.fingerprint(), vec![vec!["develop".into()], vec!["main".into()]]), Ok(()));
        assert_eq!(queue.calls(), vec!["form item-1 1 | [0]".to_string()]);

        // §9.2 holds here too: a label this question never offered, a wrong count, two picks for a single choice.
        for picks in [
            vec![vec!["trunk".into()], vec!["main".into()]],
            vec![vec!["main".into()]],
            vec![vec!["main".into(), "develop".into()], vec!["main".into()]],
            vec![vec![" main".into()], vec!["main".into()]],
        ] {
            assert_eq!(relay.answer(ask.fingerprint(), picks.clone()), Err(()), "{picks:?}");
        }
        assert_eq!(queue.calls().len(), 1);
    }

    /// A lossy request is still a reviewable approval: the phone is told the flag, not the reason the island hid it.
    #[test]
    fn the_lossy_flag_is_only_the_wire_flag() {
        let ask = ask_of(&permission_item("item-1", LOSSY_CARD, true), 1_000, BOTH).unwrap();
        let line = ask.approval_line();
        assert!(line.contains("\"truncated\":true"), "{line}");
        assert!(!line.contains("decidir en la terminal"), "the card's own tail is not sent as a field: {line}");
    }
}
