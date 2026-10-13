# Tourism: parks, stays and safaris

Citizens find and book national park entry, places to stay, and safaris and tours in the app (home → **Travel & tourism**). They pay from the wallet with their PIN, and the park permit or booking voucher lands in their Vault.

## What can be booked

| Kind | Sold by | Priced per | Example |
|---|---|---|---|
| **Park** entry | The country's parks agency (DWNP in Botswana, SANParks, MEFT in Namibia, DNPW in Zambia, ZimParks) | person per day, with citizen, SADC-resident and international rates | Chobe National Park, 2 days, 3 people at the citizen rate |
| **Stay** | Lodges, hotels, camps and guesthouses onboarded as partners (filter by category) | room per night, with room types as rates | Two nights in a family room |
| **Safari or tour** | Safari and tour operators onboarded as partners | person, for a fixed length | A 3-day camping safari for 2 adults |
| **Game reserve** | Private game reserves and conservancies (partner type `game_reserve`) | person per day (entry), or person (a guided game drive) | Day entry at citizen rate, or a 3-hour game drive |
| **Driver or transfer** | Drivers, driver-guides and transfer companies (partner type `transport`) | vehicle per day (driver-guide), or vehicle per trip (airport transfer) | A minibus from the airport to the lodge |

Every listing has a daily **capacity** (rooms, seats or permits). Kgotla never sells more than that on any day, even when two people book the last room at the same time. Bookings that overlap partly are counted night by night.

## For citizens

1. Browse by kind and region, or search, without signing in.
2. Open a listing: choose the rate, the date, how many nights or days, and how many rooms or people. The next 14 days' space is shown, and the total updates as you go.
3. **Review**: the read-back shows place, dates, people, price, total, the free-cancellation deadline and who gets paid. Confirm with the PIN.
4. The permit or voucher is issued to the Vault (and an SMS is sent). It can be shown at the gate or reception, or shared with a link.
5. **My trips** lists bookings. Cancelling before the cut-off (24 hours for parks, 48 to 72 hours for stays and safaris, set per listing) refunds the full amount to the wallet at once. After the cut-off a booking can still be cancelled, but nothing is refunded, and the app says so before you confirm.

## For parks agencies

Gate staff sign in to the officer console (an officer account with the parks agency code, for example `DWNP`) and see the **Park permits** tab: every valid permit for a chosen day, with holder name, last 4 characters of their ID, people and rate. They check the visitor's ID card and tap **Check in**, after which the permit cannot be used again.

Fees collected are owed to the agency in the ledger (`payable:agency:<code>`), the same way licence fees are.

## For hotels, lodges and tour operators

They onboard through the partner hub as type **hotel** or **tour_operator** ([PARTNERS.md](PARTNERS.md)). Kgotla checks their tourism licence with the country's tourism regulator: the Department of Tourism in Botswana, the Namibia Tourism Board, the Zimbabwe Tourism Authority, the Ministry of Tourism in Zambia, and grading or guide registration in South Africa.

Once approved, they publish and update listings through the API or see them in the partner portal:

```bash
curl -s -X PUT https://<cell>/v1/partner/listings -H "authorization: Bearer $TOKEN" -H "content-type: application/json" -d '{
  "key": "garden-rooms", "name": "Kasane Baobab Camp", "region": "Chobe · Kasane",
  "description": "Tented camp under baobabs, five minutes from the Chobe riverfront.",
  "highlights": ["River cruises", "Pool"],
  "rates": [{"key": "tent", "label": "Safari tent (2 people)", "price": "900.00"}],
  "capacity": 6, "cancelHours": 48
}'
```

- `GET /v1/partner/listings`: their listings
- `GET /v1/partner/tourism-bookings?from=YYYY-MM-DD&days=30`: bookings with guest name and pairwise subject id
- Webhooks: `tourism_booking.confirmed` and `tourism_booking.cancelled` (with the refund)
- Set `"active": false` to hide a listing; suspended partners disappear from search at once

Payments are owed to the partner in the ledger (`payable:partner:<id>`). Paying them out to the partner's bank account is part of settlement, which is still to be built (see PARTNERS.md).

## Demo data

Each demo cell has three real national parks with **demo prices**, plus a demo lodge and a demo safari operator with two listings each. The lodge and operator names are invented. Demo sign-ins:

- Partner portal: `hotel@demo.kgotla` and `safari@demo.kgotla`, with the demo officer password.
- Local API keys: `demo-hotel` / `demo-hotel-secret` and `demo-tour_operator` / `demo-tour_operator-secret`.
- Gate officer: `parks.gate`.

## Before a pilot

- **Confirm every park fee** with the parks agency, including vehicle, camping and guide fees, which are not modelled yet. The demo figures are placeholders.
- **Connect to the parks agencies' own booking systems** where they exist (SANParks, for example, takes online bookings), so capacity is shared and not double-sold across channels. The same goes for lodges that use a channel manager.
- **Visitors from abroad** cannot book yet, because Kgotla accounts need a national ID. Adding passport-based visitor accounts would open Kgotla to tourism exports, not just local travel.
- **Residency checks**: the citizen rate is for enrolled citizens; SADC-resident rates need proof of residence at the gate until residence permits are in the Vault.
- **Combined trips** (park plus stay plus safari in one checkout) and **deposits** instead of full prepayment are natural next steps.
