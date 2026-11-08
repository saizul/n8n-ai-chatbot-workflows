# n8n AI Chatbot Workflows

Ready-to-import [n8n](https://n8n.io) workflows for AI sales and support chatbots on Facebook Messenger and WhatsApp.

[![Validate workflows](https://github.com/saizul/n8n-ai-chatbot-workflows/actions/workflows/validate.yml/badge.svg)](https://github.com/saizul/n8n-ai-chatbot-workflows/actions/workflows/validate.yml)

| File | Channel | What it does |
|------|---------|--------------|
| [`ecommerce_ai_chatbot_workflow.json`](ecommerce_ai_chatbot_workflow.json) | Messenger + WhatsApp | AI sales assistant that collects order details step by step, creates a WooCommerce order, hands over to a human on Telegram, and sends follow-ups to idle chats |
| [`facebook_book_ai_workflow.json`](facebook_book_ai_workflow.json) | Messenger | Book-shop bot that answers from a Google Sheet product list, identifies a book from a photo (OpenAI vision), creates WooCommerce orders, notifies an agent by Gmail |
| [`whatsapp_book_ai_workflow.json`](whatsapp_book_ai_workflow.json) | WhatsApp Cloud API | Same book-shop bot for WhatsApp (text + image) |
| [`Saizul Personal Ai.json`](Saizul%20Personal%20Ai.json) | Messenger | Page assistant with human takeover: the AI stays quiet while you reply manually, and resumes with `#ai` |

All credentials, IDs and addresses in the JSON files are placeholders (`YOUR_GOOGLE_SHEET_ID`, `YOUR-WORDPRESS-SITE.com`, `YOUR_AGENT_EMAIL@gmail.com`, ...). Nothing is pre-configured. Add your own credentials in n8n after import.

## Common setup (all workflows)

1. In n8n choose **Workflows -> Add workflow -> Import from file** and select the JSON file.
2. Create the credentials listed for that workflow below and attach them to the nodes that show a warning.
3. Replace every `YOUR_...` placeholder (the sticky notes on the nodes say where).
4. Create the Google Sheet tabs described below. Column headers must match exactly.
5. Copy the production URL of the webhook node (`https://<your-n8n-host>/webhook/<path>`) into your Meta app's webhook settings, then activate the workflow.

Meta also verifies a webhook URL with a `GET` request carrying `hub.challenge`. The webhook nodes in these workflows only accept `POST`, so you need to handle that one-time verification yourself, for example with a small extra `GET` webhook that returns the challenge value, before Meta will deliver messages.

Messenger and WhatsApp enforce a 24-hour customer-care window. The follow-up scheduler in these workflows only looks at chats idle for 30 to 120 minutes, but check Meta's current messaging policies before enabling it.

## 1. `ecommerce_ai_chatbot_workflow.json`

- **Webhooks:** `facebook-webhook` and `whatsapp-webhook` (both `POST`).
- **Flow:** normalise the message -> load conversation state -> AI agent (`gpt-4o-mini`) or order-collection agent -> if the order is confirmed, `POST` to the WooCommerce REST API -> Telegram alert when the reply signals a handover -> reply on the right channel -> save state. A separate schedule trigger runs every 30 minutes and sends an AI-written follow-up to unfinished order chats.
- **Credentials:** OpenAI; Google Sheets; Telegram bot; Header Auth `Authorization: Bearer <token>` for the WhatsApp Cloud API; Query Auth `access_token` for the Facebook Page; Basic Auth (WooCommerce consumer key as user, secret as password).
- **Replace:** `YOUR-WORDPRESS-SITE.com` (order node), `YOUR_TELEGRAM_CHAT_ID`, `YOUR_GOOGLE_SHEET_ID`, `YOUR_PHONE_NUMBER_ID` (WhatsApp follow-up fallback).
- **Sheet:** tab `conversation_state` with columns `sender_id | channel | page_id | conversation_history | order_state | last_contact_time | followup_sent`.
- **Note:** the *Get Conversation State* node is a generic lookup by `sender_id`; its node note suggests swapping it for your own store (Postgres, Airtable, Supabase). If you keep Google Sheets, point it at the `conversation_state` tab with a row lookup on `sender_id`.

## 2. `facebook_book_ai_workflow.json`

- **Webhook:** `facebook-book-webhook` (`POST`).
- **Flow:** text messages are answered by the AI agent using rows from the `products` tab; photos are downloaded, the cover is identified with OpenAI vision (`gpt-4o`), matched against the sheet and answered. Confirmed orders go to WooCommerce, handover requests email an agent via Gmail, and idle chats get a follow-up every 30 minutes.
- **Credentials:** OpenAI; Google Sheets; Gmail; Query Auth `access_token` (Page token); Basic Auth for WooCommerce.
- **Replace:** `YOUR_GOOGLE_SHEET_ID`, `YOUR-WORDPRESS-SITE.com`, `YOUR_AGENT_EMAIL@gmail.com`.
- **Sheet tabs:**
  - `products`: `book_title | author | price | stock | category | description | offer | image_url`
  - `conversation_state`: `sender_id | channel | page_id | conversation_history | order_state | last_contact_time | followup_sent`

## 3. `whatsapp_book_ai_workflow.json`

- **Webhook:** `whatsapp-book-webhook` (`POST`).
- **Flow:** identical to the Facebook book bot, plus two extra `HTTP` steps that resolve the WhatsApp media id to a URL and download the image with the same Bearer token.
- **Credentials:** OpenAI; Google Sheets; Gmail; Header Auth `Authorization: Bearer <WhatsApp token>` (used for replies and media download); Basic Auth for WooCommerce.
- **Replace:** `YOUR_GOOGLE_SHEET_ID`, `YOUR-WORDPRESS-SITE.com`, `YOUR_AGENT_EMAIL@gmail.com`.
- **Sheet tabs:** same `products` and `conversation_state` tabs as above.

## 4. `Saizul Personal Ai.json`

- **Webhook:** `saizul-page-webhook` (`POST`). Subscribe the Page to message and echo events so your own manual replies reach the workflow.
- **Flow:** every incoming event is normalised and checked against `conversation_state`. When you reply manually in the chat (an echo that does not match the last AI message), human mode is switched on and the AI stays silent; writing `#ai` in that chat switches it off. Human mode also expires automatically after 6 hours without a manual reply. Messages the AI flags as critical trigger an email to you.
- **Credentials:** OpenAI (`gpt-4o-mini`); Google Sheets; Gmail; Query Auth `access_token` for the Page.
- **Replace:** `YOUR_GOOGLE_SHEET_ID`, `YOUR_EMAIL@gmail.com`.
- **Sheet:** tab `conversation_state` with columns `user_id | page_id | conversation_history | last_ai_message | human_mode | last_human_time | last_contact_time`.

## Validation

`scripts/validate-workflows.js` checks every workflow JSON in the repo: it must parse, every node needs a unique name, type and position, connections must point to existing nodes, no node may be left unconnected, and no API keys, bearer tokens or hard-coded secrets may be embedded. It runs on every push and pull request (see `.github/workflows/validate.yml`) and locally with:

```bash
node scripts/validate-workflows.js
```

No dependencies are needed beyond Node.js 18 or newer.

## Author

[Saizul Amin](https://saizul.com): web developer, SEO and automation specialist.
