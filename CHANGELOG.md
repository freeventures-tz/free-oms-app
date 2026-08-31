# Changelog

What each release of Free Ventures OMS adds, in plain language.

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
