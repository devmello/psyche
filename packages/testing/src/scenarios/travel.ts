// V4 travel fakes: fixture airlines and fares, and the call descriptions (purchase cards) for
// holding, ticketing and cancelling. Cards are built from the fixture offer, never from what the
// agent claims about it.
import { formatAmount } from "../../../vault/src/payments/broker.ts";
import type { Json } from "./types.ts";

export interface Airline {
  id: string;
  name: string;
  origin: string;
  checkoutPath: string;
  holdHours: number;
  freeCancelHours: number;
  pnrPrefix: string;
}

export interface Segment {
  flight: string;
  from: string;
  to: string;
  depart: string;
  arrive: string;
}

export interface Offer {
  offerId: string;
  airline: string;
  cabin: string;
  fareClass: string;
  basicEconomy: boolean;
  seat: string;
  totalMinor: number;
  currency: string;
  segments: Segment[];
  /** Airline page text shown with the offer (untrusted; V4 plants an injection here). */
  note?: string;
}

export interface FlightsFixture {
  traveler: { name: string };
  airlines: Airline[];
  offers: Offer[];
}

/** The fixed Link payment method of the scenario wallet (test mode). */
export const TEST_FUNDING = { id: "csmrpd_test_visa", brand: "visa", last4: "1881" } as const;

export function money(amountMinor: number, currency: string): string {
  return formatAmount(amountMinor, currency.toUpperCase());
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** `LV 212 SFO→ORD Nov 3 07:05`: local times as the airline prints them. */
export function segmentLine(s: Segment): string {
  const local = s.depart.slice(11, 16);
  const day = DAY.format(new Date(`${s.depart.slice(0, 10)}T12:00:00Z`));
  return `${s.flight} ${s.from}→${s.to} ${day} ${local}`;
}

export class FlightsWorld {
  readonly fx: FlightsFixture;

  constructor(fx: FlightsFixture) {
    this.fx = fx;
  }

  airline(idOrOrigin: unknown): Airline | undefined {
    const v = String(idOrOrigin ?? "");
    return this.fx.airlines.find(
      (a) => a.id === v || a.origin === v || a.origin === v.replace(/\/$/, ""),
    );
  }

  offer(offerId: unknown): Offer | undefined {
    return this.fx.offers.find((o) => o.offerId === String(offerId ?? ""));
  }

  /** Every fare on the route and dates, cheapest first, as the airlines' pages list them. */
  search(p: Json): Json[] {
    const from = String(p.from ?? "").toUpperCase();
    const to = String(p.to ?? "").toUpperCase();
    const depart = String(p.depart ?? "");
    const ret = String(p.return ?? "");
    return this.fx.offers
      .filter((o) => {
        const out = o.segments[0];
        const back = o.segments[o.segments.length - 1];
        return (
          out !== undefined &&
          back !== undefined &&
          out.from === from &&
          out.to === to &&
          out.depart.startsWith(depart) &&
          (ret === "" || back.depart.startsWith(ret))
        );
      })
      .sort((a, b) => a.totalMinor - b.totalMinor)
      .map((o) => {
        const a = this.airline(o.airline);
        return {
          offerId: o.offerId,
          airline: a?.name ?? o.airline,
          airlineOrigin: a?.origin ?? "",
          cabin: o.cabin,
          fareClass: o.fareClass,
          basicEconomy: o.basicEconomy,
          seat: o.seat,
          total: money(o.totalMinor, o.currency),
          totalMinor: o.totalMinor,
          currency: o.currency,
          flights: o.segments.map(segmentLine),
          holdHours: a?.holdHours ?? 0,
          ...(o.note === undefined ? {} : { note: o.note }),
        };
      });
  }
}

const funded = `Visa •••• ${TEST_FUNDING.last4}`;

/** `travel.hold_fare`: a once-only purchase card for the fare the fixture offers. */
export function holdDescription(w: FlightsWorld, p: Json) {
  const offer = w.offer(p.offerId);
  const airline = w.airline(p.airline);
  if (offer === undefined || airline === undefined) return undefined;
  const flights = offer.segments.map(segmentLine);
  const total = money(offer.totalMinor, offer.currency);
  return {
    kind: "purchase" as const,
    sideEffect: "financial" as const,
    target: { kind: "origin" as const, value: airline.origin, display: airline.name },
    bindingFields: {
      merchant: new URL(airline.origin).host,
      offerId: offer.offerId,
      flights,
      traveler: String(p.traveler ?? ""),
      fareClass: offer.fareClass,
      cabin: offer.cabin,
      amountMinor: offer.totalMinor,
      currency: offer.currency,
      paymentSourceId: `stripe_link:${TEST_FUNDING.id}`,
      cardLast4: TEST_FUNDING.last4,
    },
    summary:
      `Hold ${airline.name} ${flights.join(" + ")} for ${String(p.traveler ?? "")}, ${offer.cabin} (fare class ${offer.fareClass}), ` +
      `${total}: the card is authorized now and charged only when you ticket; the hold lasts ${airline.holdHours} h. ` +
      `Stripe Link, funded by ${funded}.`,
  };
}

/** `travel.ticket_hold`: charge the held amount (a second once-only purchase card). */
export function ticketDescription(
  w: FlightsWorld,
  p: Json,
  held: { amountMinor: number; currency: string; flights: string[] } | undefined,
) {
  const airline = w.airline(p.airline);
  if (airline === undefined || held === undefined) return undefined;
  const total = money(held.amountMinor, held.currency);
  return {
    kind: "purchase" as const,
    sideEffect: "financial" as const,
    target: { kind: "origin" as const, value: airline.origin, display: airline.name },
    bindingFields: {
      merchant: new URL(airline.origin).host,
      holdRef: String(p.holdRef ?? ""),
      amountMinor: held.amountMinor,
      currency: held.currency,
      paymentSourceId: `stripe_link:${TEST_FUNDING.id}`,
      cardLast4: TEST_FUNDING.last4,
    },
    summary: `Ticket the held fare ${String(p.holdRef ?? "")} at ${airline.name} (${held.flights.join(" + ")}): charge ${total} to the Stripe Link card funded by ${funded}.`,
  };
}

/** `travel.cancel_booking`: cancel and refund (destructive; once or task). */
export function cancelDescription(
  w: FlightsWorld,
  p: Json,
  booked: { amountMinor: number; currency: string } | undefined,
) {
  const airline = w.airline(p.airline);
  if (airline === undefined || booked === undefined) return undefined;
  const total = money(booked.amountMinor, booked.currency);
  return {
    kind: "connector_action" as const,
    sideEffect: "destructive" as const,
    target: { kind: "origin" as const, value: airline.origin, display: airline.name },
    bindingFields: {
      merchant: new URL(airline.origin).host,
      confirmation: String(p.confirmation ?? ""),
      refundMinor: booked.amountMinor,
      currency: booked.currency,
    },
    summary: `Cancel ${airline.name} booking ${String(p.confirmation ?? "")} and refund ${total} to the Stripe Link card (free within ${airline.freeCancelHours} h of ticketing).`,
  };
}

/** Where a trip stands, as its itinerary card says. */
export type TripState =
  | { state: "on hold"; holdRef: string; holdExpiresAt: string }
  | { state: "booked"; holdRef: string; confirmation: string; freeCancelUntil: string }
  | { state: "cancelled"; holdRef: string; confirmation: string; refundRef: string };

/** One itinerary per trip, keyed by the hold: holding writes it, ticketing and cancelling update it. */
export function itineraryName(holdRef: string): string {
  return `itinerary-${holdRef.toLowerCase()}`;
}

const WHEN = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

/**
 * The trip's itinerary artifact, built from the fixture offer and the booking (never from what
 * the model says about them): flights, traveler, cabin and fare class, the total, and where the
 * payment stands. Card data never appears; the funding card shows as its last4.
 */
export function itinerary(
  airline: Airline,
  offer: Offer,
  traveler: string,
  trip: TripState,
): { name: string; type: "itinerary"; title: string; content: string } {
  const first = offer.segments[0];
  const last = offer.segments[offer.segments.length - 1];
  const day = (iso: string) => DAY.format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
  const title =
    first === undefined || last === undefined
      ? `${airline.name} trip`
      : `${first.from} → ${first.to}, ${day(first.depart)} – ${day(last.depart)}`;
  const total = money(offer.totalMinor, offer.currency);
  const fare =
    trip.state === "on hold"
      ? `${total} on hold with ${airline.name} (ref ${trip.holdRef}), not charged yet; the hold ends ${WHEN.format(new Date(trip.holdExpiresAt))}`
      : trip.state === "booked"
        ? `${total} charged to the Stripe Link card funded by ${funded}; confirmation ${trip.confirmation}, free cancellation until ${WHEN.format(new Date(trip.freeCancelUntil))}`
        : `booking ${trip.confirmation} cancelled; ${total} refunded to the Stripe Link card (ref ${trip.refundRef})`;
  const content = [
    `# ${title} (${trip.state})`,
    "",
    ...offer.segments.map((s) => `- **Flight**: ${segmentLine(s)} → ${s.arrive.slice(11, 16)}`),
    `- **Traveler**: ${traveler} · ${offer.cabin} (fare class ${offer.fareClass}), ${offer.seat}`,
    `- **Airline**: ${airline.name} (${new URL(airline.origin).host})`,
    `- **Fare**: ${fare}`,
  ].join("\n");
  return { name: itineraryName(trip.holdRef), type: "itinerary", title, content };
}
