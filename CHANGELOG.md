# Changelog

What each release of Free Ventures OMS adds, in plain language.

## [0.3.2] — 2026-09-26

### FIXED

- When a Director or the Manager acted on imprest funding and no answer came back, closing and
  reopening the form lost the warning and its Try again button. Trying again by hand then drew a
  new request, which could be refused as out of date even though the first one had gone through.
  The warning and Try again now stay until Try again finds out what happened, and the other
  actions on that funding wait until then.

## [0.3.1] — 2026-09-26

### FIXED

- On a tablet, the menu rail sat above the page instead of beside it, so every screen opened on
  the menu and you had to scroll past it to reach the page. The rail now runs down the left side
  with the page next to it.

## [0.3.0] — 2026-09-25

Cashiers can now propose imprest payments, and the Manager approves or rejects them. Paying out,
receipts and checking a payment come in a later release; until then an approved payment stays set
aside until the Manager cancels it. The staff workflows stay closed.

### NEW

- A Cashier can propose a payment out of the imprest fund: pick one of the nine categories, enter
  the amount in whole shillings, and write a short purpose or pick one used recently. A proposal
  sets no money aside.
- The Manager approves a proposal at the amount proposed, or rejects it with a reason. Approving
  sets the money aside at once, so the same cash can't be approved twice. An approval for more than
  is free to approve is refused and nothing changes, even when two approvals arrive together.
- The Cashier can withdraw their own proposal before the Manager decides, with a reason. The
  Manager can cancel an approval before it is paid, with a reason, which frees the money again.
  The history keeps the approval and the cancellation.
- The Imprest screen now shows three figures to the Manager and Directors: posted imprest funding,
  set aside for approved payments, and free to approve. It lists the proposals waiting for a
  decision, with a count, and each open approval with how long it has been open. Directors read
  it without acting.
- Cashiers reach Imprest from the menu for the first time. They see only what is free to approve
  and their own proposals with each one's status.

## [0.2.2] — 2026-09-25

Nothing changes for people using the app.

### IMPROVED

- Releases are simpler. The automatic version and tagging system, which was never switched on, is
  gone, along with its checks on pull request titles. Each change is now versioned, noted here and
  tagged by hand when it is merged.

## [0.2.1] — 2026-09-25

Nothing changes for people using the app. This release makes the automated checks behind it more
dependable.

### FIXED

- The production checks no longer fail at random after the local database restarts. They recorded
  batches as moulded "right now" by the test machine's clock, and when the database clock ran a
  moment behind, the app correctly refused a moulding time in the future. The checks now record
  batches as moulded a minute earlier. The app's own rule is unchanged.

## [0.2.0] — 2026-09-23

<!-- release-controller:begin version=0.2.0 base=v0.1.0 preparation=53 -->
Generated from every accepted merge after `v0.1.0`. Each preparation replaces the lines between these markers; write prose above or below them.

Version policy 0.x. Highest change: minor. No breaking change and no deprecation.

### Accepted merges (2)

1. **feat(reports): scheduled daily report with retries and a final-failure alert** — [#52](https://github.com/freeventures-tz/free-oms-app/pull/52) · merge [`364feb5`](https://github.com/freeventures-tz/free-oms-app/commit/364feb5e7a642cd4653bcac1bd21b078770660b0) · `feat` → minor
2. **chore(release): prepare 0.2.0** — [#53](https://github.com/freeventures-tz/free-oms-app/pull/53) · this release's preparation · `chore` → patch
<!-- release-controller:end -->

## [0.1.0] — 2026-09-21

**Imprest funding now runs in the application.** A Manager asks for operating cash, a Director
approves an amount or rejects the request with a reason, a Director records the cash actually handed
over, and the Manager confirms what arrived. Either Director may act, and every step keeps its own
amount, person and time: what was requested, approved, handed over and received are four separate
figures, never one.

**Only the Manager's confirmation adds money.** A request, an approval, an approval increase, a
handover and a Director's correction add nothing to posted imprest funding. Confirming the handover
on screen posts that exact amount once; a retry, a second tap or a stale screen cannot post it
again.

**A handover can be less than approved, and more needs an approval increase first.** If the cash
counted differs from what was recorded, the Manager reports the mismatch with the amount counted,
zero included. A Director records the corrected handover with an explanation, and the Manager
confirms it or reports again. Every approval, handover and count stays in the history.

**This is funding only, and the staff workflows stay closed.** The total shown is confirmed funding,
not a cash count. Spending, expense evidence, daily cash counts, variance and retirement are not in
this release. Nothing here activates an account or opens day-to-day operation.

<!-- release-controller:begin version=0.1.0 base=v0.0.7 preparation=50 -->
Generated from every accepted merge after `v0.0.7`. Each preparation replaces the lines between these markers; write prose above or below them.

Version policy 0.x. Highest change: minor. No breaking change and no deprecation.

### Accepted merges (2)

1. **feat(imprest): request, provide and confirm imprest funding with discrepancy history** — [#49](https://github.com/freeventures-tz/free-oms-app/pull/49) · merge [`4bc7fa9`](https://github.com/freeventures-tz/free-oms-app/commit/4bc7fa97601f12f3ff97b4117d5023b65ad564fb) · `feat` → minor
2. **chore(release): prepare 0.1.0** — [#50](https://github.com/freeventures-tz/free-oms-app/pull/50) · this release's preparation · `chore` → patch
<!-- release-controller:end -->

## [0.0.7] — 2026-09-20

**An invoice on an order now says what has actually been paid.** It said "Unpaid" — on every
invoice ever issued, to everybody. The card was written in the stage before payments existed and
nothing revisited it when they arrived, so a Cashier could take the whole bill at the till, open
the order the money was for, and read that nothing had been paid. The status is now the one the
payments screen shows, because both read the same record.

**Money and credit are different things, and the card keeps them apart.** An invoice settled
entirely on credit still reads Unpaid, because nothing was paid; part tender plus credit reads
Partly paid on the tender alone. The approved balance is listed beside the money with its own
label, never added to it.

**A Sales Representative is told the status is not shown, rather than told it is Unpaid.** Payment
records are not part of that role, and the honest answer to a question you may not ask is not
zero. Everything else on the invoice — its number, its lines, its totals, and whether it was
cancelled — is unchanged for them.

**The staff workflows stay closed.** Nothing here activates an account, opens day-to-day
operation, or changes any payment, reversal, cancellation or dispatch command. This release
changes one screen and what it reads.

### Fixed

- **The invoice card on an order shows the current payment status, the money received and the
  balance due.** Calculated from money actually received, never chosen, and read from the
  settlement record rather than from a page of payments.
- **A settlement figure that cannot be stated exactly is a failed read, not a figure.** A missing
  or malformed record reaches the page-level retry instead of quietly becoming "Unpaid" or zero,
  and that now includes an amount too large for the application to hold without rounding it.

<!-- release-controller:begin version=0.0.7 base=v0.0.6 preparation=47 -->
Generated from every accepted merge after `v0.0.6`. Each preparation replaces the lines between these markers; write prose above or below them.

Version policy 0.x. Highest change: patch. No breaking change and no deprecation.

### Accepted merges (7)

1. **test(settlement): prove the walk-in sale landed before reloading on it** — [#32](https://github.com/freeventures-tz/free-oms-app/pull/32) · merge [`78275d2`](https://github.com/freeventures-tz/free-oms-app/commit/78275d2247be9ab57bb39d2b140a5223a7213e89) · `test` → patch
2. **test: set the yard as well as the ledger, and wait for the inspection** — [#33](https://github.com/freeventures-tz/free-oms-app/pull/33) · merge [`91cb9b8`](https://github.com/freeventures-tz/free-oms-app/commit/91cb9b8a552b9384f49a2ac67260d5e765176939) · `test` → patch
3. **ci(release): preview releases, tag exact merges and recover missed build tags** — [#42](https://github.com/freeventures-tz/free-oms-app/pull/42) · merge [`93bcd0b`](https://github.com/freeventures-tz/free-oms-app/commit/93bcd0be0ff8bd905651c6ae61115acbf1fabb6e) · `ci` → patch
4. **ci(release): prepare normal releases and gate their tags on evidence** — [#43](https://github.com/freeventures-tz/free-oms-app/pull/43) · merge [`af45203`](https://github.com/freeventures-tz/free-oms-app/commit/af45203715a835b4f30c6bc211ede680887219f9) · `ci` → patch
5. **test(inventory): date the future-delivery fixture on the business clock (\#34)** — [#44](https://github.com/freeventures-tz/free-oms-app/pull/44) · merge [`b2573e2`](https://github.com/freeventures-tz/free-oms-app/commit/b2573e263464c10d53a263a13a6b9fff949ecb78) · `test` → patch
6. **fix(sales): show the invoice's real payment status on its order** — [#46](https://github.com/freeventures-tz/free-oms-app/pull/46) · merge [`f78ce49`](https://github.com/freeventures-tz/free-oms-app/commit/f78ce49313a13430ca98ad2de6441c2b646a4e16) · `fix` → patch
7. **chore(release): prepare 0.0.7** — [#47](https://github.com/freeventures-tz/free-oms-app/pull/47) · this release's preparation · `chore` → patch
<!-- release-controller:end -->

## [0.0.6] — 2026-09-09

**Stock that has been sold stays sold.** Making bricks and writing stock off both used to look at
one thing: how much was standing in that place. Goods a customer had already paid for are standing
there too, so a batch could grind up cement that was sold, and the delivery that followed found an
empty yard. From this release every command that takes stock out of the business asks the same
question the sales screens have always asked — how much is there that nobody has been promised.

**The staff workflows stay closed until this release has been verified in production.** This is the
correction the v0.0.5 entry promised. The production, sales and stock workflows remain closed to
day-to-day operation until v0.0.6 has passed production verification, which is a separate step with
its own approval. Nothing here activates an account or launches an operation.

### Fixed

- **A brick batch cannot consume material a customer has been promised.** A hundred bags in the
  yard with eighty of them sold is twenty bags a batch may use, and a batch asking for fifty is
  refused — with all four figures on the screen, in English and Swahili: what can be used, what is
  promised to customers, what is physically there, and what was asked for. A refusal that said
  only "not enough" while the Manager was looking at a full yard read as the system being wrong.
- **A downward stock correction is refused on the same rule.** Writing off goods somebody has paid
  for is the same loss to that customer as grinding them up. An upward correction takes nothing
  out of the business and is refused by neither rule.
- **The place is still checked, separately, and says so.** "The business does not own enough that
  is not already promised" and "this place does not hold it" are different problems needing
  opposite actions — buy more, or move what you have — so they are now two refusals with two
  sentences instead of one message covering both.
- **Moving stock between our own places is unaffected.** A transfer from the store to the yard
  changes where goods are, not whether the business still owns them, so promised goods may still
  be moved. Only the source location has to hold them.
- **A reservation and a batch approval can no longer both take the last of the stock.** They were
  queueing on two different keys for one quantity, so each could read the same hundred bags and
  proceed. They now serialise against one another.
- **Availability cannot go below zero even if a command forgets to ask.** A deferred check at the
  end of every transaction refuses it outright — a backstop for a command written next year, not a
  replacement for the queueing above.
- **One of our own checks was reading the wrong record, and now names what it is asking about.**
  The check that proves a refusal reaches the record asked for "the most recent refusal" at a moment
  when several of them shared one timestamp, so it could read a different refusal than the one it
  meant — reporting "this place does not hold it" where it should have found "somebody has already
  been promised it". Nothing a person sees was ever wrong, and no rule changed: the refusals
  themselves were correct throughout. The check now asks about the exact batch or correction it is
  testing, so it cannot wander onto another one.

### Changed

- **A refused stock command is now recorded.** Who tried, in which role, what they asked for, what
  the answer was and when. A refused attempt to consume eighty bags somebody had already paid for
  previously left no trace at all. All sixteen inventory and production commands record one.

## [0.0.5] — 2026-09-02

**Making bricks.** This release adds the mixer batch, the materials it actually consumed, the
bricks that came out of the mould, the 72 hours they spend curing, and the inspection that decides
how many of them may be sold. Petty cash, reconciliation and reports are still not in the system.

**The staff workflows in this release are not open for normal use yet.** Brick approval checks what
is physically at the location; it does not yet refuse materials a customer has already been promised
(§8.1). That correction ships as **v0.0.6**, and until it has been verified in production the
production, sales and stock workflows stay closed to day-to-day operation. Nothing here activates an
account or launches an operation.

### New

- **The batch form arrives already filled in.** One bag of Dangote Cement 42R, five buckets of
  sand, five buckets of aggregate — the standard recipe, as the expected quantities. A Manager who
  used exactly that types nothing and confirms; changing a figure is the exception, and the
  difference from the standard appears beside it as they type. There is no field to type a
  difference into, on the screen or in the database. Water is a utility cost and is never stock.
- **Recording a batch moves nothing.** Approving it is what takes the materials out of the yard,
  and the control says so before it is pressed. The same Manager may record a batch and later
  approve it — two separate acts, each with its own actor, role and time. A rejection is a
  completed decision that needs a reason, records no approver, and consumes nothing.
- **The deduction is what was actually used, never the recipe.** A batch that used six buckets of
  sand takes six. The variance is recorded at whatever size it is and never used to pull the
  deduction back toward the standard. One bag of cement deducts one bag, not the fifty kilograms
  inside it.
- **Every material is answered for.** A batch that mentioned two of the three materials is refused:
  silence about the third is not a confirmation of it. Confirming that a batch used **none** of
  something is a different thing, and is accepted.
- **A batch may produce five-inch bricks, six-inch bricks or both**, with the moulding rejects
  counted separately. Twenty to twenty-five six-inch and twenty-five to thirty five-inch are the
  expected ranges; a count outside one is **flagged and explained, never blocked**, and an
  explanation offered for a normal batch is refused so that an explanation always means something
  happened.
- **Each size cures as its own lot, on its own clock.** Curing starts at the moulding-completion
  time the Manager states — the form offers the yard's current time, in Dar es Salaam, whatever the
  phone is set to — and only a time in the future is refused. Each lot shows when it is due and how
  long is left, and a page left open catches up on its own when the deadline passes.
- **Reaching the end of curing grants nothing.** After 72 hours a lot reads **Ready for
  inspection**, and nothing more. Before that the inspection control is disabled with its reason
  shown, and the database refuses an early inspection whatever the screen believes.
- **Only what a Manager accepts becomes sellable.** The inspection accounts for the whole lot —
  accepted plus rejected equals what cured — and the entire lot leaves curing once. A lot in which
  nothing was accepted is a real outcome and writes no phantom balance. Rejects stay recorded on
  the lot and never become stock.
- **Reject reasons are four buttons**, at the mould and again at inspection: Broken, Cracked,
  Undersized, Weak. There is no text field for one anywhere. A count with no reason is refused, and
  so is a reason with nothing to explain.
- **Drafts and curing lots are separate, paged queues.** A batch waiting for a decision stays
  reachable however much history sits in front of it, and each section says how much is off screen.
- **A Manager runs production and a Director reads it.** A Director is offered no control on the
  board at all — not a greyed one. A Cashier and a Sales Representative cannot reach the screen,
  its rows or its commands.
- Everything on these screens is in English and Kiswahili, and works on a phone, a tablet and a
  desktop.

### Fixed

- **The Stock screen no longer says the yard is empty while bricks are standing in it.** It says it
  shows what is physically at each location and read only the sellable balance, so approving a
  batch put twenty bricks in the yard that the page reported as none. Curing is now its own figure
  on the card, never added to the sellable one and never left out.
- **Previous and Next in a paged queue are back to a 44-pixel target on a tablet.** They had
  dropped to 40, below the touch floor the design sets.
- **A refused rejection or inspection now says what was wrong.** Rejecting a batch with too short a
  reason, or recording an inspection with the accepted count left blank, used to finish in silence:
  the control stopped working, nothing was saved, and the screen never explained itself. The reason
  is now read out, shown against the field it is about, and everything already entered stays where
  it was.
- **Correcting a figure no longer sends the answer to a question that has gone.** Entering rejects,
  choosing Cracked and then recounting to zero used to submit the reason anyway, and the database
  refused the whole batch or inspection over a control that was no longer on the screen. The same
  happened to an explanation for output that turned out to be within its range. The choice is kept,
  so putting the count back restores it; what is sent is what the screen shows.
- **A figure typed with a leading zero is the number it looks like.** `018` moulded is eighteen, and
  `02` thrown away is two. The screen used to treat all of those as nothing typed yet: no difference
  shown, no explanation asked for when the count was outside its range, and no reject reason offered
  when one was about to be compulsory -- while the figure itself was recorded exactly as a Manager
  meant it. A numeric keypad produces leading zeros by accident, and the screen and the record now
  read them the same way. Anything that is not a whole count is still shown as nothing and still
  refused.

### Improved

None.

## [0.0.4] — 2026-09-01

**Taking money, and letting the goods go.** This release adds payment, credit, settlement, the
walk-in sale that completes at the till, payment reversal, the storekeeper records a dispatch is
assigned to, and the signed release that finally takes stock out of the yard. Brick production,
petty cash, reconciliation and reports are still not in the system.

### New

- **A Cashier's payment queue.** Every invoice waiting for money is a card, and the balance due is
  the largest figure on it. Six ways of paying are buttons — cash, Mixx by YAS, Halopesa, a Mwanga
  Hakika transfer, a CRDB transfer, a cheque — and the amount arrives already filled in with the
  whole balance, so a full payment is one tap and a confirmation. Amounts are whole shillings.
  Taking more than is owed is refused, and the refusal says what is owed and what was offered.
- **Nobody chooses an invoice's status.** Unpaid, Partly paid and Paid are worked out from the
  money recorded against the invoice, and there is no control anywhere to set one by hand.
- **Credit is not money, and the screen never pretends otherwise.** It sits apart from the six
  tender buttons, and choosing it changes the panel from *amount received* to *amount to be carried
  as credit, pending approval*. An invoice carried entirely on credit still reads **Unpaid**, with
  the approved balance recorded beside it. A Manager may approve up to TZS 500,000 on one invoice;
  above that it is a Director's, and the screen names the limit that was crossed rather than
  offering a decision it is going to refuse. Approving and rejecting are separate records, and a
  rejection has to say why.
- **Settling is its own deliberate act.** A fully paid invoice is marked settled by the Cashier;
  an approved credit balance can settle one without pretending money arrived. Settling changes what
  the stock is held for — from a confirmed order's reservation to goods committed to that
  customer — **without changing the quantity and without moving anything**.
- **A walk-in sale is one action at the counter.** Taking the money re-checks that the goods are
  still there, creates the invoice, records the payment against it and commits the stock, all in
  one go. If any part of it fails there is no invoice, no payment and no hold — nothing at all is
  left behind. A walk-in sale must be paid in full: it cannot be part-paid, carried on credit, or
  held before payment.
- **A payment can be put right without being rewritten.** A Cashier or a Manager asks for a
  reversal and only a Director approves it. The approved reversal is a new, negative entry pointing
  at the payment it undoes, and the original stays exactly as it was recorded. The same payment
  cannot be reversed twice, and a reversal cannot itself be reversed.
- **Storekeepers are a record, not a login.** A Director registers one with a name, an optional
  phone number, the date they started and an optional note; the system generates their code. A
  storekeeper is switched off, never deleted, so past dispatches keep naming the person who
  actually moved the goods, and only somebody currently working can be assigned to a new one. A
  Manager reads the list and is offered no controls at all.
- **Handing goods over takes four steps, and only the last one moves stock.** A Cashier assigns a
  settled invoice to a storekeeper and says which location the goods come from, for all of what is
  owed or part of it — and the screen says plainly that assigning moves nothing. A Manager types
  the number off the physical carbon-copy book; the system does not print dispatch notes and says
  so, and the same number cannot be recorded twice. Confirming the release is refused, with the
  reason shown, until that number exists. Only a Manager confirms the customer has signed, and
  **only that confirmation takes the stock out of the yard**. A partial release leaves the rest
  committed and still waiting.
- **Paid and not yet collected is a list of its own**, with the invoice, the customer, what is
  still owed to them and how many days it has been waiting. Goods in that state are physically in
  the yard and cannot be sold to anybody else.
- **Each role is offered only its own work.** A Manager reads payments and is offered no way to
  take money; a Cashier is offered no way to confirm a release; a Sales Representative cannot reach
  dispatch at all.
- Everything on these screens is in English and Kiswahili, and works on a phone, a tablet and a
  desktop.

### Fixed

- **Create New Order no longer shows a stale catalogue.** Adding a product, setting a price or
  moving stock now refreshes the order screen straight away, instead of leaving a Sales
  Representative to wonder why something they were told about is not there yet.

### Improved

None.

## [0.0.3] — 2026-08-31

**Selling.** This release adds customers, orders, quotations, invoices, discounts and the stock a
confirmed order holds. Taking money, authorising credit, settling an invoice and releasing goods
are still not in the system, and neither are brick production, petty cash and reports. A walk-in
(Cash Customer) order can be written and confirmed, and says plainly that nothing is owed and
nothing is held until payment — and payment is not in this release.

### New

- **Customers are a record.** A Sales Representative, a Manager or a Director adds a customer by
  name without waiting for anybody, and the same name typed with different capitals or spacing is
  recognised as the customer who already exists. A Cashier reads customers and does not create
  them.
- **Writing an order, without typing a single total.** Search for the customer and pick them from
  the results; search for each product and pick it from a card that shows its price and how many
  can be sold; set the quantity with a stepper. Every line total and the subtotal are worked out
  for you, and there is nowhere to type one. A product no Director has priced cannot be put on an
  order at all.
- **On a phone the order is three steps** — customer, then items, then a review — with the number
  of items and the running total always on screen. Going back a step keeps everything already
  entered. If something is missing when you submit, the screen lists what it is, takes you to the
  first one, and keeps everything you typed. On a tablet or a desktop the same three sections are
  all visible at once, with the running total beside them.
- **A quotation appears by itself.** Submitting an order produces a numbered quotation with the
  date it is valid until. Nobody creates one by hand, and the screen says plainly that a quotation
  is not a bill: nothing is owed and no stock is held until the customer confirms.
- **The customer can change their mind before they accept.** Revise the quotation from the order
  screen — change a quantity, add an item, drop one — and a new version is issued. Every earlier
  version stays readable, so what the customer was told last week is still there.
- **Discounts go to whoever may decide them.** A Manager may approve up to 5%, and only on an order
  above one million shillings. Every other discount is a Director's — to **approve or to refuse**,
  because refusing one settles it just as finally as granting it. The screen names the limit before
  anybody taps anything and offers a Manager no decision they cannot make, and the database refuses
  one who reaches it anyway, judging the limit on what the order comes to now rather than on what
  it came to when the discount was asked for. An approved discount re-quotes the customer, and a
  rejection has to say why. **Everyone who may confirm the order can see it is waiting on that
  decision**, including a Sales Representative who did not ask for it, so nobody is offered a
  confirmation the system is going to refuse.
- **Confirming an order creates exactly one invoice** and holds the stock for that customer. It
  takes two deliberate steps — the screen names what confirming will do and waits for a second,
  separate press, because it creates a financial record. If the system refuses — the stock has gone
  while the order sat, say — **it says so where you are standing, with the figures and a way to try
  again**, rather than leaving you to close the question to find the answer. The goods stay
  physically where they are; what changes is that they can no longer be sold to somebody else.
  Confirming twice, or two people confirming at the same moment, still produces one invoice and one
  hold.
- **An invoice cannot be changed by anybody.** A correction is a cancellation and a new order.
- **Cancelling an order** releases the stock it was holding and records why. A confirmed order
  keeps its invoice and its invoice number, marked cancelled with the reason beside it. Any
  discount still waiting for a decision is withdrawn with the order, and the withdrawal is written
  down as a decision of its own — who did it, from which role, when, and why — with nobody
  recorded as having approved anything.
- **Every order names who wrote it**, to everyone who is allowed to open that order — a Cashier and
  another Sales Representative included, without either of them gaining anything else about that
  person: not their phone number, not their role, not whether their account is still switched on.
  Where a reader is not entitled to an actor's name, the screen says what happened without
  pretending to name somebody — and if the name cannot be read at all, the page says the order
  could not be loaded and offers to try again, rather than showing the order with a blank where a
  person should be. None of these records can be written directly by any account, including a
  Director's.
- **Each role is offered only what its work needs.** A Cashier reads orders and is offered no way
  to start one; a Sales Representative is offered no way to decide a discount.
- Everything on these screens is in English and Kiswahili, and works on a phone, a tablet and a
  desktop.

### Fixed

- **A confirmed order can now be cancelled from the order screen.** The rule and the permanent
  record behind it already worked, but the screen offered the button only while the order was still
  a quotation, so an order confirmed by mistake could not be withdrawn without help.

### Improved

None.

## [0.0.2] — 2026-08-30

**Stock.** This release adds who Free Ventures buys from, what is physically at each location, and
every movement behind that figure. Selling, payments, dispatch, brick production, petty cash and
reports are still not in the system.

### New

- **Suppliers are a record, not a name typed on a delivery.** A Director adds a supplier and can
  switch one off. A supplier is never deleted, because deliveries already recorded keep pointing at
  it, and one that is switched off cannot be chosen for a new delivery. A Manager sees the list and
  has no way to change it.
- **A stock screen for each location** — the store, the warehouse and the yard. It shows what is
  physically there, product by product, in the unit that product is counted by, and every movement
  behind that figure. A product nobody has counted yet says so instead of showing zero.
- **Opening stock.** A Director records once, for each product at each location, what was already
  there when the system started counting. Zero is a real answer if you counted and found none.
  After that the figure only moves through a delivery, a transfer or a correction.
- **Recording what arrived from a supplier.** A Manager, a Cashier or a Sales Representative enters
  the supplier, the delivery note number, the date, and for each product what was expected, what
  actually arrived and what arrived damaged. Short and excess are worked out for you and kept.
  **Nothing reaches stock until a Manager approves it**, and damaged goods are recorded and never
  added to stock at all.
- **Moving stock between locations.** A Manager records a transfer from one location to another and
  can see what is at the source right now while entering it. The balances change only after a
  Manager approves the transfer.
- **Correcting a figure that is wrong.** A Manager records the change and why it is needed — a
  reason is required — and **a Director approves or rejects it.** Nothing changes until a Director
  decides.
- **A rejection has to say why**, and the reason is kept beside the decision permanently.
- **Every movement names two people**: who recorded it and who approved it. Movements cannot be
  edited or deleted afterwards by anyone, and the system refuses any movement that would leave a
  location holding less than nothing.
- **Each role only sees the screens its work needs.** A Sales Representative and a Cashier reach
  supplier receiving and nothing else in stock. A Manager works on all four stock screens. A
  Director reads receiving, decides corrections, and owns suppliers and opening stock.
- Everything on these screens is in English and Kiswahili, and works on a phone.

### Fixed

None.

### Improved

None.

## [0.0.1] — 2026-08-14

The first release. It covers **getting into the system and managing who has access**. The parts of
the business it will eventually run — stock, sales, payments, production, cash and reports — are not
in this release.

### Signing in

- Sign in with your **phone number and a password**. No email address and no codes by SMS.
- Type the number however you normally would — `0712 345 678`, `+255 712 345 678` or
  `255712345678` — and the screen shows you the form it will be saved as while you type.
- **New accounts start with a temporary password that must be replaced the first time you sign in.**
  Until that is done, nothing else in the system opens. The rules for a good password are shown
  before you type, and tick off as you meet them.
- After signing in you go straight to your own home page, which depends on your role.

### What Directors can do

- Create an account for a member of staff, and hand them a temporary password shown **once**.
- Set a new password for someone who has lost theirs.
- Switch an account off, and switch it back on.
- Change someone's role, or the phone number they sign in with.

Every one of these is recorded permanently, and the screen says so.

### Language

- Everything is available in **English and Kiswahili**, and you can switch at any time — including
  before you sign in.
- Your choice follows you between devices.

### Devices

- Works on **phones, tablets and computers**.
- On a phone it can be added to the home screen and opened like any other app.

### Added to 0.0.1 after the tag was cut

The product catalogue below went live between 14 and 21 August 2026, as part of the same 0.0.1
release. The `v0.0.1` tag was created before it, so the tag does not contain it — but it is running
today, and it is not part of 0.0.2.

#### Products and prices

- **The catalogue is in the system.** All 21 products Free Ventures sells are there, each with the
  unit it is sold by — pieces, 12 ft pieces, 50 kg bags, 20-litre buckets, sheets and bars.
- **Grade is part of what a product is.** Nondo 12 mm BS 300 and Nondo 12 mm BS 500 are two
  separate products, not one product with a note attached, so they can never be priced or counted
  as if they were the same thing.
- **A Director can set and change a selling price**, in whole shillings. Every change asks why, and
  keeps the answer.
- **Price history cannot be edited or deleted by anyone.** Each entry shows the price, the price it
  replaced, who set it and when. A price you quoted last year still reads exactly as it was set.
- **A product with no price says so.** It never shows a price of zero, and nothing can be sold at a
  figure no Director approved.
- **A Manager can see every product, every price and the full history**, and has no way to change
  one — there is no greyed-out button and no explanation of what they cannot do.
- Adding a product and setting a price are separate decisions. A new product arrives with no price
  until a Director sets one.
- Everything on these screens is in English and Swahili.

#### Everywhere

- Tapping something answers **immediately**, without waiting for the system. Pages that are loading
  show the shape of what is coming rather than a blank screen, buttons that are working say so
  without changing size, and pressing one twice still does the job once.
- If something cannot be reached, the screen says so and offers to try again — rather than showing
  an empty list as though there were nothing there.
