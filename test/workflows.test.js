'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { loadWorkflow, runCode, ROOT } = require('./helpers');

const FILES = fs.readdirSync(ROOT).filter((f) => f.endsWith('.json')).sort();
const ECOM = 'ecommerce_ai_chatbot_workflow.json';
const FB_BOOK = 'facebook_book_ai_workflow.json';
const WA_BOOK = 'whatsapp_book_ai_workflow.json';
const PERSONAL = 'Saizul Personal Ai.json';

const target = (wf, from, output = 0) =>
  ((wf.connections[from] || {}).main || [])[output]?.map((t) => t.node) || [];

// ---- Meta webhook verification ---------------------------------------------------

for (const file of FILES) {
  test(`${file}: every POST webhook has a GET verification twin`, () => {
    const wf = loadWorkflow(file);
    const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
    const posts = hooks.filter((n) => n.parameters.httpMethod === 'POST');
    assert.ok(posts.length > 0);
    for (const post of posts) {
      const get = hooks.find((n) => n.parameters.httpMethod === 'GET' && n.parameters.path === post.parameters.path);
      assert.ok(get, `no GET webhook for path ${post.parameters.path}`);
      assert.equal(get.parameters.responseMode, 'responseNode');

      const [ifName] = target(wf, get.name);
      const check = wf.nodes.find((n) => n.name === ifName);
      assert.equal(check.type, 'n8n-nodes-base.if');
      const conds = check.parameters.conditions.conditions;
      assert.deepEqual(
        conds.map((c) => [c.leftValue, c.rightValue]),
        [
          ["={{ $json.query['hub.mode'] }}", 'subscribe'],
          ["={{ $json.query['hub.verify_token'] }}", 'YOUR_VERIFY_TOKEN'],
        ]
      );
      assert.equal(check.parameters.conditions.combinator, 'and');

      const ok = wf.nodes.find((n) => n.name === target(wf, ifName, 0)[0]);
      const no = wf.nodes.find((n) => n.name === target(wf, ifName, 1)[0]);
      assert.equal(ok.parameters.respondWith, 'text');
      assert.equal(ok.parameters.responseBody, "={{ $json.query['hub.challenge'] }}");
      assert.equal(no.parameters.options.responseCode, 403);
    }
  });
}

// ---- ecommerce: Normalize Message -------------------------------------------------

const normalize = (body) => runCode(ECOM, 'Normalize Message', { items: [{ body, headers: {} }] });

test('ecommerce: Messenger text is normalised from the webhook body', async () => {
  const [out] = await normalize({
    object: 'page',
    entry: [{ id: 'PAGE1', messaging: [{ sender: { id: 'U1' }, recipient: { id: 'PAGE1' }, message: { text: 'দাম কত?' } }] }],
  });
  assert.equal(out.channel, 'facebook');
  assert.equal(out.senderId, 'U1');
  assert.equal(out.pageId, 'PAGE1');
  assert.equal(out.messageText, 'দাম কত?');
});

test('ecommerce: WhatsApp text is not mistaken for Messenger', async () => {
  const [out] = await normalize({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ value: { metadata: { phone_number_id: 'PN1' }, messages: [{ from: '8801712345678', type: 'text', text: { body: 'hi' } }] } }] }],
  });
  assert.deepEqual([out.channel, out.senderId, out.pageId, out.messageText], ['whatsapp', '8801712345678', 'PN1', 'hi']);
});

test('ecommerce: echoes, receipts and WhatsApp status updates stop the run', async () => {
  assert.deepEqual(await normalize({ object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'P' }, message: { is_echo: true, text: 'our reply' } }] }] }), []);
  assert.deepEqual(await normalize({ object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'U' }, delivery: { mids: ['m'] } }] }] }), []);
  assert.deepEqual(await normalize({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [{ status: 'read' }] } }] }] }), []);
});

test('ecommerce: WhatsApp quick-reply buttons and Messenger postbacks carry text', async () => {
  const [wa] = await normalize({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { messages: [{ from: '88017', type: 'button', button: { text: 'Order now' } }] } }] }] });
  assert.equal(wa.messageText, 'Order now');
  const [fb] = await normalize({ object: 'page', entry: [{ id: 'P', messaging: [{ sender: { id: 'U' }, postback: { title: 'Start' } }] }] });
  assert.equal(fb.messageText, 'Start');
});

// ---- book bots: Normalize Message -------------------------------------------------

test('facebook book bot: image attachment gets a default question', async () => {
  const [out] = await runCode(FB_BOOK, 'Normalize Message', {
    items: [{ body: { entry: [{ id: 'P', messaging: [{ sender: { id: 'U' }, message: { attachments: [{ type: 'image', payload: { url: 'https://x/img.jpg' } }] } }] }] } }],
  });
  assert.equal(out.hasImage, true);
  assert.equal(out.imageUrl, 'https://x/img.jpg');
  assert.equal(out.messageText, 'এই বইটির দাম কত?');
});

test('whatsapp book bot: status updates are skipped, captions kept', async () => {
  const [skip] = await runCode(WA_BOOK, 'Normalize Message', { items: [{ body: { entry: [{ changes: [{ value: { statuses: [{}] } }] }] } }] });
  assert.equal(skip.skip, true);
  const [img] = await runCode(WA_BOOK, 'Normalize Message', {
    items: [{ body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN' }, messages: [{ from: '880', type: 'image', image: { id: 'M1', caption: 'price?' } }] } }] }] } }],
  });
  assert.deepEqual([img.hasImage, img.imageId, img.messageText, img.phoneNumberId], [true, 'M1', 'price?', 'PN']);
});

// ---- Parse AI Response ------------------------------------------------------------

test('ecommerce: ORDER_DATA block is extracted and removed from the reply', async () => {
  const content = 'ধন্যবাদ! অর্ডার কনফার্ম। [ORDER_DATA:{"stage":"confirmed", "collected":{"product":"Panjabi","qty":2,"customer_name":"Rahim"}}]';
  const [out] = await runCode(ECOM, 'Parse AI Response', {
    items: [{ choices: [{ message: { content } }] }],
    nodes: { 'Build Context': [{ senderId: 'U1', channel: 'facebook' }] },
  });
  assert.equal(out.aiResponse, 'ধন্যবাদ! অর্ডার কনফার্ম।');
  assert.equal(out.orderData.stage, 'confirmed');
  assert.equal(out.orderData.collected.qty, 2);
  assert.equal(out.senderId, 'U1');
  assert.equal(out.needsHandover, false);
});

test('ecommerce: broken ORDER_DATA is ignored and handover keywords are detected', async () => {
  const [out] = await runCode(ECOM, 'Parse AI Response', {
    items: [{ message: { content: 'আমাদের এজেন্ট শীঘ্রই যোগাযোগ করবেন [ORDER_DATA:{not json}]' } }],
    nodes: { 'Build Context': [{}] },
  });
  assert.equal(out.orderData, null);
  assert.equal(out.needsHandover, true);
});

test('book bot: stage "handover" in ORDER_DATA triggers a handover', async () => {
  const [out] = await runCode(FB_BOOK, 'Parse AI Response', {
    items: [{ content: 'ঠিক আছে [ORDER_DATA:{"stage":"handover"}]' }],
    nodes: { 'Build Text Context': [{ messageText: 'x' }] },
  });
  assert.equal(out.needsHandover, true);
  assert.equal(out.aiResponse, 'ঠিক আছে');
});

// ---- follow-up filters ------------------------------------------------------------

const NOW = '2026-11-10T12:00:00Z';
const minsAgo = (m) => new Date(Date.parse(NOW) - m * 60000).toISOString();
const row = (o) => ({ sender_id: 'U1', channel: 'facebook', last_contact_time: minsAgo(45), followup_sent: 'false', order_state: '{"stage":"collecting_address"}', ...o });

for (const [file, node] of [[ECOM, 'Filter Inactive Conversations'], [FB_BOOK, 'Filter Inactive'], [WA_BOOK, 'Filter Inactive']]) {
  const channel = file === WA_BOOK ? 'whatsapp' : 'facebook';
  const r = (o) => row({ channel, ...o });

  test(`${file}: follow-up window is 30-120 minutes for unfinished orders`, async () => {
    const out = await runCode(file, node, {
      now: NOW,
      items: [
        r({ sender_id: 'in' }),
        r({ sender_id: 'early', last_contact_time: minsAgo(10) }),
        r({ sender_id: 'late', last_contact_time: minsAgo(180) }),
        r({ sender_id: 'sent', followup_sent: 'true' }),
        r({ sender_id: 'done', order_state: '{"stage":"confirmed"}' }),
      ],
    });
    assert.deepEqual(out.map((o) => o.senderId), ['in']);
  });

  test(`${file}: a corrupt order_state cell does not crash the run`, async () => {
    const out = await runCode(file, node, {
      now: NOW,
      items: [r({ sender_id: 'bad', order_state: '{"stage":' }), r({ sender_id: 'null', order_state: 'null' }), r({ sender_id: 'ok' })],
    });
    assert.deepEqual(out.map((o) => o.senderId), ['ok']);
  });
}

// ---- personal page bot: human takeover -------------------------------------------

const echo = (text, lastAi = 'AI said this') =>
  runCode(PERSONAL, 'Handle Page Echo', {
    nodes: {
      'Normalize Event': [{ userId: 'U1', pageId: 'P', messageText: text }],
      'Get Conversation State': [{ user_id: 'U1', last_ai_message: lastAi }],
    },
  });

test('personal bot: own AI echo is ignored, manual reply takes over, #ai resumes', async () => {
  assert.equal((await echo('AI said this'))[0].action, 'ignore');
  assert.equal((await echo('I will call you'))[0].action, 'human_takeover');
  assert.equal((await echo('#AI'))[0].action, 'resume');
});

test('personal bot: page echoes are keyed by the customer, not the page', async () => {
  const [out] = await runCode(PERSONAL, 'Normalize Event', {
    items: [{ body: { entry: [{ id: 'P', messaging: [{ sender: { id: 'P' }, recipient: { id: 'U9' }, message: { is_echo: true, text: 'hi' } }] }] } }],
  });
  assert.equal(out.isEcho, true);
  assert.equal(out.userId, 'U9');
});

test('test fixture list covers every workflow file', () => {
  assert.deepEqual(FILES, [PERSONAL, ECOM, FB_BOOK, WA_BOOK].sort());
  assert.ok(FILES.every((f) => fs.statSync(path.join(ROOT, f)).isFile()));
});
