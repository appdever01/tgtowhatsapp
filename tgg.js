const TelegramBot = require("node-telegram-bot-api");

// replace 'YOUR_TELEGRAM_BOT_TOKEN' with the token you got from BotFather
const token = "6980180034:AAGSHfIQk7PNHU4yQLnY5WilpO4VxwlwJcA";
const bot = new TelegramBot(token, { polling: true });

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Hello! I am your new bot.");

  // Path or URL to the image
  const photo =
    "https://cdn4.cdn-telegram.org/file/vPzNHjlRrgKbfdVJkWpqGVPh4SUmDPZGPPCQpvtVUYN14dTpe7g1zrANOSJUQXBGQ-WSbw0OpP62-PqIyzsOkfuy089epNPUCsjrwE-HYr8-R3bNKp49Mwrni0Tplv4ilwC4kaXhw1qiWSOJJW2dJitCzpgjYYKHe0NeKPfeAZz8T-0HjWZYTmSoJuRjk8Uc48Jgz5F5S2iCDrfa8h7xogieVqwJOdomzWQBCkgkSYwJj42m5r_02yO-bnuZwDWXgmReY9xr9CP6ky65jcPYuZRUDFbMBy9MJlCTpAxcA0ySUb6ywI863cfmVgd-XN_JcGY6IpsAKuvVHVD8mby9Aw.jpg";
  const caption = "This is the caption for your image.";

  bot.sendPhoto(chatId, photo, { caption: caption });
});

const channel = "@ehad_news"; // or '-1001234567890' for private channels with ID
const message = "Hello, channel!";

const photo =
  "https://cdn4.cdn-telegram.org/file/vPzNHjlRrgKbfdVJkWpqGVPh4SUmDPZGPPCQpvtVUYN14dTpe7g1zrANOSJUQXBGQ-WSbw0OpP62-PqIyzsOkfuy089epNPUCsjrwE-HYr8-R3bNKp49Mwrni0Tplv4ilwC4kaXhw1qiWSOJJW2dJitCzpgjYYKHe0NeKPfeAZz8T-0HjWZYTmSoJuRjk8Uc48Jgz5F5S2iCDrfa8h7xogieVqwJOdomzWQBCkgkSYwJj42m5r_02yO-bnuZwDWXgmReY9xr9CP6ky65jcPYuZRUDFbMBy9MJlCTpAxcA0ySUb6ywI863cfmVgd-XN_JcGY6IpsAKuvVHVD8mby9Aw.jpg";
const caption = "This is the caption for your image.";
bot.sendMessage(channel, message);
bot.sendPhoto(channel, photo, { caption: caption });
