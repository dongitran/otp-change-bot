const express = require("express");
const path = require("path");
const logger = require("morgan");
const { Telegraf } = require("telegraf");
const TelegramManager = require("./functions/telegram-manager");
const RocketChatManager = require("./functions/rocketchat-manager");
const { scheduleJob } = require("node-schedule");
const { databaseListener } = require("./services/database-listener");
const { insertMongo, initMongo } = require("./functions/logger");

// Load environment variables
require("dotenv").config();

initMongo().then(() => {
  insertMongo("log", { message: "Server started" });
});

// Express setup
const app = express();
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "pug");
app.use(logger("dev"));

// Bot setup and launch
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.start((ctx) => ctx.reply("Hello, I'm Database Change bot~"));
bot.on("sticker", (ctx) => ctx.reply("👍"));
bot.launch();

const telegramManager = new TelegramManager(bot, undefined, undefined);

// RocketChat setup
const rocketChatManager = new RocketChatManager(
  process.env.ROCKETCHAT_SERVER_URL,
  process.env.ROCKETCHAT_USERNAME,
  process.env.ROCKETCHAT_PASSWORD,
  process.env.ROCKETCHAT_TARGET_CHANNEL
);

// Initialize database listener to listen for database changes
databaseListener(telegramManager, rocketChatManager).catch(console.error);

// Schedule the telegram bot to send a message every 1 seconds
scheduleJob("*/1 * * * * *", async function () {
  telegramManager.sendOneMessage(true);
  rocketChatManager.sendOneMessage(true);
});

module.exports = app;