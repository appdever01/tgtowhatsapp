const axios = require("axios").default;
const {
  default: Baileys,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Configuration, OpenAIApi } = require("openai");
const { translate } = require("bing-translate-api");
const { imageSync } = require("qr-image");
const { schedule } = require("node-cron");
const { Boom } = require("@hapi/boom");
const app = require("express")();
const fs = require("fs-extra");
const chalk = require("chalk");
const port = process.env.PORT || 4002;
const skipper = process.env.SKIP || true;
const apiKey =
  process.env.OPENAI_KEY ||
  "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";
const mods = (process.env.MODS || "2347049972537")
  .split(", ")
  .map((jid) => `${jid}@s.whatsapp.net`);

const ai = new OpenAIApi(new Configuration({ apiKey }));
const errorMessage = "Response code 429 (Too Many Requests)";

const readFile = (path, value = {}) =>
  fs.existsSync(path)
    ? fs.readJSONSync(path)
    : (fs.outputJSONSync(path, value), value);

const groups = readFile("groups.json", []);
const store = readFile("store.json");

const getChannels = () => {
  groups.forEach((group) => {
    group.channels = group.channels.map((channel) => channel.toLowerCase());
  });
  fs.writeJSONSync("groups.json", groups, { spaces: 2 });
};

const removeInvalidChannel = (from, channel) => {
  const group = groups.find((group) => group.from === from);
  const index = group.channels.indexOf(channel.toLowerCase());
  group.channels.splice(index, 1);
  fs.writeJSONSync("groups.json", groups, { spaces: 2 });
};

const saveStore = (store) =>
  fs.writeJSONSync("store.json", store, { spaces: 2 });

const transcribe = async (text) => {
  let translation = "";
  const maxChunkSize = 1000;
  for (let i = 0; i < text.length; i += maxChunkSize) {
    const chunk = text.slice(i, i + maxChunkSize);
    const result = await translate(chunk, null, "he").catch((err) => ({
      translation: err.message,
    }));
    translation += result.translation;
  }
  return translation;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetch = async (username) =>
  (await axios.get(`https://weeb-api.vercel.app/telegram/${username}`)).data;

const start = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("session");
  const client = Baileys({
    version: (await fetchLatestBaileysVersion()).version,
    printQRInTerminal: true,
    auth: state,
    logger: P({ level: "fatal" }),
    browser: ["TG-WhatsApp", "fatal", "1.0.0"],
  });

  client.log = (text, error = false) =>
    console.log(
      chalk[error ? "red" : "blue"]("TG-WhatsApp"),
      chalk[error ? "redBright" : "greenBright"](text)
    );

  client.ev.on("connection.update", async (update) => {
    if (update.qr) {
      client.log(
        `QR code generated. Scan it to continue | You can also authenicate in http://localhost:${port}`
      );
      client.QR = imageSync(update.qr);
    }
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const { statusCode } = new Boom(lastDisconnect?.error).output;
      if (statusCode !== DisconnectReason.loggedOut) {
        client.log("Reconnecting...");
        setTimeout(() => start(), 3000);
      } else {
        client.log("Disconnected.", true);
        await fs.remove("session");
        client.log("Starting...");
        setTimeout(() => start(), 3000);
      }
    }
    if (connection === "connecting") client.log("Connecting to WhatsApp...");
    if (connection === "open") {
      client.log("Connected to WhatsApp");
      getChannels();
      if (!groups.length) client.log("No Groups or Channel Found", true);
      const ready = groups.every((group) => group.from);
      if (!ready) client.log("ID required type /id in group", true);
      else
        schedule(`*/20 * * * *`, async () => {
          for (const group of groups) {
            await delay(2 * 60 * 1000);
            fetchChannels(group);
          }
        });
    }
  });

  client.ev.on("messages.upsert", async ({ messages }) => {
    const formatArgs = (args) => args.slice(1).join(" ").trim();
    const prefix = "/";
    const M = messages[0];
    M.from = M.key.remoteJid || "";
    M.sender = M.key.participant || "";
    M.content = M.message?.conversation || "";
    M.reply = (text) => client.sendMessage(M.from, { text }, { quoted: M });
    const args = M.content.split(" ");
    const context = formatArgs(args);
    const cmd = args[0].toLowerCase().slice(prefix.length);
    switch (cmd) {
      case "id":
        return void M.reply(M.from);
    }
  });

  const reply = async (from, content, type = "text", caption) => {
    client.log(`wa_message: ${type}`);
    if (type === "text" && Buffer.isBuffer(content))
      throw new Error("Cannot send a Buffer as a text message");
    return client.sendMessage(from, {
      [type]: content,
      caption,
    });
  };

  const fetchChannels = async ({ from, channels }) => {
    const promises = channels.map(async (channel, channelIndex) => {
      await delay(30 * 1000 * channelIndex);
      client.log(`Checking... ${chalk.yellowBright(channel)}`);
      const messages = await fetch(channel).catch(() => {
        client.log("API is busy at the moment, try again later", true);
        return void null;
      });
      if (!messages || !messages.length) {
        // removeInvalidChannel(from, channel);
        client.log(`Invalid ${channel} removed`, true);
        return void null;
      }
      const previousId = store[channel] || 0;
      const index = messages.findIndex((message) => message.id === previousId);
      if ((previousId && index === -1) || previousId > messages.pop().id) {
        client.log(`Json is Outdated of ${channel}`, true);
        store[channel] = messages.pop().id;
        saveStore(store);
        return void null;
      }
      if (index !== -1) {
        const messagesToSend = messages.slice(index + 1);
        if (!messagesToSend.length) {
          client.log(`No new messages ${channel}`);
          return void null;
        }

        store[channel] = messagesToSend.pop().id;
        saveStore(store);
      }
      if (!previousId && messages.length) {
        client.log(`Channel store: ${chalk.yellowBright(channel)}`);
        const { id, type, caption, mediaUrl } = messages.pop();
        let text = await transcribe(caption);
        const keywords = await getKeyWords(
          text.includes(errorMessage) ? caption : text
        );
        store[channel] = id;
        saveStore(store);
        const replyData = type === "text" ? text : { url: mediaUrl };
        if (skipper && text.includes(errorMessage)) {
          client.log(
            `Skipping translation failed message from ${channel}`,
            true
          );
          return void null;
        }
        await reply(from, replyData, type, text);
      }
    });
    await Promise.all(promises);
  };

  app.get("/", (req, res) =>
    res.status(200).contentType("image/png").send(client.QR)
  );

  client.ev.on("creds.update", saveCreds);
  return client;
};

start();
app.listen(port, () => console.log(`Server started on PORT : ${port}`));
