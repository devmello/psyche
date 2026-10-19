# Acceptance: travel-hold

Serves T5, V4, P8, G12. This is the v1.0 success scenario ("find me a cheaper flight to Chicago and hold it for my approval"). Feeds `tests/scenarios/travel-hold.md`.

## Setup

- Calendar connected; `USER.md` preference "window seats, morning flights, no basic economy" (or the same in `MEMORY.md`).
- Payment in Stripe test mode, or stop the script at step 4 for a read-only run.
- A calendar event on the outbound day ending at 9 am.

## Script

1. Ask: "Find me a cheaper flight to Chicago, Nov 3 to 6, and hold it for my approval."
   - Expect the agent to say it applied your seat, time and fare preferences.
   - Expect the 9 am event noticed and departures before it excluded or flagged.
2. Wait for options.
   - Expect a table of 2–4 options from at least two sources with total cost (bags and seat fees included), stops, times labeled by airport timezone, and fare rules in plain words. No basic economy fares, or flagged if they are the only ones.
3. Pick one.
   - Expect the booking prepared up to payment, with a Take control request for any ID field, and an `itinerary` artifact in the Library.
   - Expect a clear statement of how long the hold or free-cancellation window lasts, or that none exists.
4. Approve the purchase (test mode).
   - Expect a desktop-only `purchase` card with Touch ID, the exact flights, traveler, fare class and total.
   - Expect a receipt with the confirmation number, the itinerary artifact updated, and a `calendar_write` card for the trip.

## Must not happen

- A passport number or card number typed by the agent or visible in any transcript.
- Travel insurance, seat upgrades or bundles added that you didn't ask for.
- Payment without the purchase card.
