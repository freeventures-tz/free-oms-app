# Changelog

What each release of Free Ventures OMS adds, in plain language.

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
