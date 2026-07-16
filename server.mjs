import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8000);
const envText = await readFile(path.join(root, ".env"), "utf8").catch(() => "");
envText.split(/\r?\n/).forEach(line => {
  const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
});

function send(response, status, body, type = "application/json") {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(type === "application/json" ? JSON.stringify(body) : body);
}

function outputText(payload) {
  if (payload.output_text) return payload.output_text;
  return (payload.output || []).flatMap(item => item.content || []).find(item => item.type === "output_text")?.text || "";
}

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["entries"],
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source_message_index", "payer", "amount", "description", "split_with", "confidence", "evidence"],
        properties: {
          source_message_index: { type: "integer", minimum: 0 },
          payer: { type: "string" },
          amount: { type: ["number", "null"] },
          description: { type: "string" },
          split_with: { type: "array", items: { type: "string" } },
          confidence: { type: "string", enum: ["confirmed", "needs_confirmation"] },
          evidence: { type: "string" }
        }
      }
    }
  }
};
const receiptSchema = {
  type: "object",
  additionalProperties: false,
  required: ["is_receipt", "merchant", "amount", "items", "confidence"],
  properties: {
    is_receipt: { type: "boolean" },
    merchant: { type: ["string", "null"] },
    amount: { type: ["number", "null"] },
    items: { type: "array", items: { type: "string" } },
    confidence: { type: "string", enum: ["high", "low"] }
  }
};

async function extract(chat) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const prompt = `Read this WhatsApp group-chat export and identify only shared expenses. The chat may mix English, Hindi, and Hinglish (for example: "maine wifi ka 1200 diya" means the sender paid 1200 for Wi-Fi). Return one entry for each expense.

An amount is confirmed only when the chat explicitly states it or a clearly associated receipt corrects it. Never invent or round an amount. If an expense is mentioned but the amount is vague, set amount to null and confidence to needs_confirmation. Treat "nvm", "ignore that", "wrong amount", and "cancel" as corrections: do not return the superseded amount. Treat "paid me back", "settled", and "bhej diya" as reimbursements, not new expenses.

Do not calculate balances or transfers. Use the sender as payer only when the message supports that they paid. source_message_index is zero-based within the chat messages as supplied.\n\nCHAT:\n${chat}`;
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-5.6",
      reasoning: { effort: "low" },
      input: prompt,
      text: { format: { type: "json_schema", name: "chatledger_entries", strict: true, schema } }
    })
  });
  const payload = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(payload.error?.message || "The OpenAI request failed.");
  return JSON.parse(outputText(payload));
}

async function readReceipt(imageUrl) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const apiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-5.6",
      reasoning: { effort: "low" },
      input: [{ role: "user", content: [
        { type: "input_text", text: "Read this image only if it is a receipt. Extract the merchant, final total, and purchased items. Never guess an unreadable amount." },
        { type: "input_image", image_url: imageUrl }
      ] }],
      text: { format: { type: "json_schema", name: "chatledger_receipt", strict: true, schema: receiptSchema } }
    })
  });
  const payload = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(payload.error?.message || "The receipt scan failed.");
  return JSON.parse(outputText(payload));
}

async function transcribe(audioUrl) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured on the server.");
  const [, mime, encoded] = audioUrl.match(/^data:([^;]+);base64,(.+)$/) || [];
  if (!mime || !encoded) throw new Error("Unsupported voice-note format.");
  const extension = ({ "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/ogg": "ogg", "audio/wav": "wav", "audio/webm": "webm" })[mime] || "audio";
  const form = new FormData();
  form.set("model", "gpt-4o-mini-transcribe");
  form.set("prompt", "This is a WhatsApp shared-expense voice note. Preserve Indian names, rupee amounts, Hindi, and Hinglish accurately.");
  form.set("file", new Blob([Buffer.from(encoded, "base64")], { type: mime }), `voice-note.${extension}`);
  const apiResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form });
  const payload = await apiResponse.json();
  if (!apiResponse.ok) throw new Error(payload.error?.message || "The voice-note transcription failed.");
  return payload.text;
}

http.createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/api/extract") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const { chat } = JSON.parse(body);
      if (typeof chat !== "string" || !chat.trim() || chat.length > 500000) throw new Error("Upload a chat export under 500 KB.");
      send(response, 200, await extract(chat));
    } catch (error) {
      send(response, 400, { error: error.message || "Unable to analyse this chat." });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/api/receipt") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const { imageUrl } = JSON.parse(body);
      if (typeof imageUrl !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(imageUrl) || imageUrl.length > 7000000) throw new Error("Choose a PNG, JPG, or WebP receipt under 5 MB.");
      send(response, 200, await readReceipt(imageUrl));
    } catch (error) {
      send(response, 400, { error: error.message || "Unable to scan this receipt." });
    }
    return;
  }
  if (request.method === "POST" && request.url === "/api/transcribe") {
    let body = "";
    for await (const chunk of request) body += chunk;
    try {
      const { audioUrl } = JSON.parse(body);
      if (typeof audioUrl !== "string" || !audioUrl.startsWith("data:audio/") || audioUrl.length > 12000000) throw new Error("Choose a supported voice note under 8 MB.");
      send(response, 200, { text: await transcribe(audioUrl) });
    } catch (error) {
      send(response, 400, { error: error.message || "Unable to read this voice note." });
    }
    return;
  }
  if (request.method !== "GET") return send(response, 405, { error: "Method not allowed." });
  const pathname = request.url === "/" ? "index.html" : decodeURIComponent(request.url.split("?")[0]).replace(/^\/+/, "");
  const filePath = path.resolve(root, "dist", pathname);
  if (!filePath.startsWith(path.resolve(root, "dist") + path.sep) && filePath !== path.resolve(root, "dist", "index.html")) return send(response, 404, { error: "Not found." });
  try {
    const resolved = await stat(filePath).then(info => info.isFile() ? filePath : path.join(root, "dist", "index.html"));
    const type = resolved.endsWith(".css") ? "text/css" : resolved.endsWith(".js") ? "text/javascript" : resolved.endsWith(".svg") ? "image/svg+xml" : resolved.endsWith(".jpeg") || resolved.endsWith(".jpg") ? "image/jpeg" : resolved.endsWith(".png") ? "image/png" : resolved.endsWith(".webp") ? "image/webp" : "text/html";
    send(response, 200, await readFile(resolved), type);
  } catch { send(response, 404, { error: "Build the app first with npm run build." }); }
}).listen(port, () => console.log(`ChatLedger running at http://localhost:${port}`));
