# ChatLedger

> Your WhatsApp group already knows who paid. ChatLedger makes it fair.

ChatLedger turns shared-living group chats into a clear, auditable settle-up. GPT-5.6 extracts the fuzzy human context; deterministic code handles the money.

## What it does

- Reads WhatsApp `.txt` exports, including Hinglish phrasing
- Extracts expenses with GPT-5.6 structured output
- Calculates balances and minimum payments deterministically
- Holds vague amounts or splits for human confirmation
- Reads receipt images and transcribes voice notes

## Run locally

Requirements: Node.js 20+ and an OpenAI API key with API billing enabled.

```bash
cp .env.example .env
# Add OPENAI_API_KEY to .env
npm install
npm run build
node server.mjs
```

Open `http://localhost:8000`.

## Deploy on Render

The repository includes [`render.yaml`](render.yaml) for a Render web service.

1. In Render, choose **New +** → **Blueprint** and select this GitHub repository.
2. Keep the generated build and start commands unchanged.
3. Add `OPENAI_API_KEY` as a private environment variable in Render. Never add it to the repository.
4. Deploy. Render will provide a public URL for the demo.

For interface-only development:

```bash
npm run dev
```

## Try it

- Click **Show settle-up** for the four-friend demo.
- Upload [samples/weekend-split.txt](samples/weekend-split.txt) once API access is active.
- Review any item in **Needs a human check** before it changes balances.

## Demo video outline

1. Show the messy shared-expense chat.
2. Use **Show settle-up** to reveal the verified four-friend example.
3. Point out that unclear expenses go to human review rather than changing money silently.
4. Show the three minimum payments.
5. Explain that Codex built the product and GPT-5.6 extracts language/receipts, while deterministic code handles all arithmetic.

## Architecture

1. GPT-5.6 converts chat language into schema-validated expense candidates.
2. React maps candidates to people and source messages.
3. Deterministic balance and debt-netting code calculates final payments.
4. Receipt and voice-note routes provide evidence; people approve uncertain cases.

## Privacy

The browser never receives the OpenAI API key. The local server reads it from `.env`. Chat text and media are sent to OpenAI only after a user explicitly uploads them; this hackathon prototype does not persist them.

## Built with Codex and GPT-5.6

Codex accelerated the interaction design, parser safety cases, deterministic ledger logic, React UI, and verification workflow. GPT-5.6 performs structured chat and receipt extraction; it is deliberately excluded from arithmetic and payment calculations.
