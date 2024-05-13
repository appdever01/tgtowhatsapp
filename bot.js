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
const { load } = require("cheerio");
const app = require("express")();
const fs = require("fs-extra");
const chalk = require("chalk");
const port = process.env.PORT || 3000;
const skipper = process.env.SKIP || true;
const apiKey =
  process.env.OPENAI_KEY ||
  "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";
const mods = (process.env.MODS || "923224875937")
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
const words = readFile("words.json");

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

const saveWords = async (content) => {
  words.keywords = words.keywords || [];
  words.keywords = [
    ...new Set([...words.keywords, ...(Array.isArray(content) ? content : [])]),
  ];
  fs.writeJSONSync("words.json", words, { spaces: 2 });
};

const updateWords = (category, element) => {
  const index = isNaN(element)
    ? words.keywords.indexOf(element)
    : parseInt(element);
  if (isNaN(index) || index < 0 || index >= words.keywords.length)
    return "Not Found";
  const removed = words.keywords.splice(index, 1)[0];
  words.roles = words.roles || [];
  let role =
    words.roles.find((r) => r[category]) ||
    (words.roles.push({ [category]: [] }), words.roles[words.roles.length - 1]);
  role[category].push(removed);
  fs.writeJSONSync("words.json", words, { spaces: 2 });
  return "OK";
};

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

// const getKeyWords = async (context) => {
//   if (!apiKey) return [];
//   const messages = [
//     {
//       role: "system",
//       content:
//         "Identify and list person or company names from the paragraph in a JavaScript array, exclusively using Hebrew. Translate names written in other languages to Hebrew as needed.",
//     },
//     { role: "user", content: context.trim() },
//   ];
//   try {
//     const { data } = await ai.createChatCompletion({
//       model: "gpt-3.5-turbo-16k",
//       messages,
//     });
//     const { content } = data.choices[0]?.message;
//     if (!content || !/^\[\s*".*"\s*\]$/.test(content)) return [];
//     return JSON.parse(content) || [];
//   } catch (error) {
//     console.error(error.message);
//     return [];
//   }
// };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetch = async (username) =>
  await axios
    .get(`https://t.me/s/${username}`)
    .then(({ data }) => {
      const $ = load(data);
      const result = [];
      $(".tgme_widget_message_wrap").each((index, element) => {
        const video = $(element).find("video").attr("src");
        const image = $(element)
          .find(".tgme_widget_message_photo_wrap")
          .attr("style")
          ?.match(/url\('([^']+)'\)/)[1];
        const text = $(element).find(".tgme_widget_message_text").text().trim();
        const type = image ? "image" : video ? "video" : "text";
        const caption =
          text ||
          $(element)
            .next(".tgme_widget_message_text")
            .html()
            ?.trim()
            ?.replace(/<br>/g, "\n")
            ?.replace(/<(?:.|\n)*?>/gm, "") ||
          "";
        const time = $(element)
          .parent()
          .find(".tgme_widget_message_date time")
          .attr("datetime");
        const views = $(element)
          .parent()
          .find(".tgme_widget_message_views")
          .first()
          .text()
          .trim();
        const url = $(element).find(".tgme_widget_message_date").attr("href");
        const id = parseInt(url.split("/").pop() || 0);
        const mediaUrl = video || image || undefined;
        result.push({ id, type, caption, views, time, url, mediaUrl });
      });
      return result;
    })
    .catch((error) => {
      console.log(error.message);
      return [];
    });

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
        schedule(`*/5 * * * *`, async () => {
          for (const group of groups) {
            await delay(1 * 60 * 1000);
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
      case "list": {
        if (!mods.includes(M.sender))
          return void M.reply("Only mods can use it");
        if (!(words.keywords || []).length)
          return void M.reply("No keywords found");
        const keywordsList = words.keywords
          .map((word, index) => `${index}. ${word}`)
          .join("\n");
        return void M.reply(`Words List:\n\n${keywordsList}`);
      }
      case "roles":
      case "analysis": {
        if (!mods.includes(M.sender))
          return void M.reply("Only mods can use it");
        const roles = words.roles || [];
        if (!roles.length) return void M.reply("No roles available.");
        let rolesList = "🟩 Word List 🟩";
        rolesList += `\n🍥 Total Categories: ${roles.length}`;
        rolesList += `\n\n${roles
          .map(
            (role) =>
              `*${Object.keys(role)}:*\n${role[Object.keys(role)]
                .map((word, index) => `${index + 1}. ${word}`)
                .join("\n")}`
          )
          .join("\n\n")}`;
        return void M.reply(rolesList.trim());
      }
      case "role":
      case "categorize": {
        if (!mods.includes(M.sender))
          return void M.reply("Only mods can use it");
        if (!context) return void M.reply("Provide a keyword, Baka!");
        const [role, element] = context.trim().split("|");
        if (!role || !element) return void M.reply("Do role|element");
        const roles = updateWords(role.trim().toLowerCase(), element);
        return void M.reply(
          roles === "OK" ? "🟩 Updated roles" : "🟥 Element not available"
        );
      }
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
      if (!messages.length) {
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
        messagesToSend.forEach(async (message, messageIndex) => {
          const { type, caption, mediaUrl } = message;
          let text = await transcribe(caption);
          // const keywords = await getKeyWords(
          //   text.includes(errorMessage) ? caption : text
          // );
          // saveWords(keywords);
          text = `*${channel}*\n\n${text}`;
          const replyData = type === "text" ? text : { url: mediaUrl };
          if (skipper && text.includes(errorMessage)) {
            client.log(
              `Skipping translation failed message from ${channel}`,
              true
            );
            return void null;
          }
          await delay(5000 * messageIndex);
          await reply(from, replyData, type, text);
        });
        store[channel] = messagesToSend.pop().id;
        saveStore(store);
      }
      if (!previousId && messages.length) {
        client.log(`Channel store: ${chalk.yellowBright(channel)}`);
        const { id, type, caption, mediaUrl } = messages.pop();
        let text = await transcribe(caption);
        // const keywords = await getKeyWords(
        //   text.includes(errorMessage) ? caption : text
        // );
        // saveWords(keywords);
        text = `*${channel}*\n\n${text}`;
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
        console.log(`From:::: ${from}`);
        console.log(`From:::: ${replyData}`);
        console.log(`From:::: ${type}`);
        console.log(`From:::: ${text}`);
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
