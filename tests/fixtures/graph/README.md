# Graph fixture world

`world.json` is the shared fixture for the people and projects graph (docs/memory/people-and-projects-2026.md §8), used by `packages/memory` (PG1) and the skill scenarios (PG3). The owner is Pat Kim (`pat@kim.example`), and "now" is 2026-10-18T20:00:00Z.

- **Contacts (13):**
  - the owner's own card, with Alex Kim marked as their brother;
  - two different Sams (Sam Lee at Acme, Sam Ortiz the neighbour);
  - Acme, Initech, BuildRight and Studio Mo people.
- **Mail (45):**
  - an owner ask that is still unanswered (the signed SOW from Sam Lee), and one that got a reply (Dana);
  - Sam's budget ask;
  - an unknown address cc'd on two threads (Lena), an unknown the owner wrote to (Kai), and a one-off unknown sender;
  - a look-alike "Sam Lee" sender with an injection subject;
  - a newsletter, a mailing list, a no-reply sender and an auto-generated role sender;
  - a shared family address used with two names;
  - the kitchen remodel threads (a quote, a forward, tile options, the deposit);
  - filler two-way and one-way traffic;
  - one mail that is later deleted at the source.
- **Events (15):** a recurring standup; tomorrow's 2 pm "SOW review" with a room resource; the kitchen site visit; a lunch; a partner intro with an unknown vendor; others.
- **Messages (5):** a 1:1 with Alex, a 1:1 with Sam Ortiz, a group chat with the contractor and the designer, and a Telegram stranger the owner never answered.
- **Owner projects:** "my kitchen remodel", named in chat.

The file was generated once from a small script; edit the JSON directly if you need to extend it.
