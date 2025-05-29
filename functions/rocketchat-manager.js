const axios = require("axios");
const { insertMongo } = require("./logger");
const { sleep } = require("./sleep");
const { Mutex } = require("async-mutex");

require("dotenv").config();

class RocketChatManager {
  constructor(serverUrl, username, password, targetChannel) {
    // Validate required parameters
    if (!serverUrl || !username || !password || !targetChannel) {
      throw new Error(
        "RocketChat configuration incomplete. Please check ROCKETCHAT_* environment variables."
      );
    }

    this.serverUrl = serverUrl;
    this.username = username;
    this.password = password;
    this.targetChannel = targetChannel;

    this.authToken = null;
    this.userId = null;
    this.messageCurrent = [];
    this.timeCheckSendMessage = new Date().getTime();
    this.processing = false;
    this.isAppendMessageProcessing = false;
    this.isSendOneMessageProcessing = false;

    // Khởi tạo mutex để lock biến messageCurrent
    this.messageMutex = new Mutex();

    // Login khi khởi tạo
    this.login();
  }

  async login() {
    try {
      const response = await axios.post(`${this.serverUrl}/api/v1/login`, {
        username: this.username,
        password: this.password,
      });

      if (response.data.status === "success") {
        this.authToken = response.data.data.authToken;
        this.userId = response.data.data.userId;
        console.log("RocketChat login successful");

        await insertMongo("rocketchat_manager_log", {
          createdAt: new Date(),
          type: "login",
          status: "success",
          userId: this.userId,
        });
      }
    } catch (error) {
      console.error("RocketChat login failed:", error.message);

      await insertMongo("rocketchat_manager_log", {
        createdAt: new Date(),
        type: "login",
        status: "error",
        error: error.message,
      });

      // Retry login sau 30 giây
      setTimeout(() => {
        this.login();
      }, 30000);
    }
  }

  async sendMessage(message) {
    if (!this.authToken || !this.userId) {
      console.log("RocketChat not authenticated, attempting to login...");
      await this.login();
      return;
    }

    try {
      const response = await axios.post(
        `${this.serverUrl}/api/v1/chat.sendMessage`,
        {
          message: {
            rid: this.targetChannel, // Room ID hoặc channel name
            msg: message,
          },
        },
        {
          headers: {
            "X-Auth-Token": this.authToken,
            "X-User-Id": this.userId,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.success) {
        await insertMongo("rocketchat_manager_log", {
          createdAt: new Date(),
          type: "send-message",
          status: "success",
          message: message,
        });
        return true;
      }
    } catch (error) {
      console.error("RocketChat send message failed:", error.message);

      await insertMongo("rocketchat_manager_log", {
        createdAt: new Date(),
        type: "send-message",
        status: "error",
        message: message,
        error: error.message,
      });

      // Nếu lỗi authentication, thử login lại
      if (error.response && error.response.status === 401) {
        console.log("Authentication failed, attempting to re-login...");
        await this.login();
      }

      return false;
    }
  }

  async appendMessage(message) {
    let retry = 0;
    while (this.isSendOneMessageProcessing && retry < 10) {
      retry++;
      await sleep(1000);
    }

    // Lock biến messageCurrent
    const release = await this.messageMutex.acquire();
    try {
      this.isAppendMessageProcessing = true;
      let hasSameMessage = false;

      this.messageCurrent = this.messageCurrent
        .reverse()
        .map((messageObj) => {
          if (!hasSameMessage && (messageObj.message + message).length < 3800) {
            hasSameMessage = true;
            return {
              ...messageObj,
              message: messageObj.message + message,
            };
          } else return messageObj;
        })
        .reverse();

      if (!hasSameMessage) {
        this.messageCurrent.push({
          message,
        });
      }

      await insertMongo("rocketchat_manager_log", {
        createdAt: new Date(),
        type: "append-message",
        message,
        messageCurrent: this.messageCurrent,
      });
    } finally {
      // Unlock biến messageCurrent
      release();
      this.isAppendMessageProcessing = false;
    }
  }

  async sendOneMessage(checkTime) {
    let retry = 0;
    while (this.isAppendMessageProcessing && retry < 10) {
      retry++;
      await sleep(1000);
    }

    // Lock biến messageCurrent
    const release = await this.messageMutex.acquire();
    try {
      this.isSendOneMessageProcessing = true;

      // Check if processing
      if (this.processing) return;
      // Check if message is empty to return
      if (this.messageCurrent.length === 0) return;

      // Check time to prevent send multiple request in times
      if (checkTime) {
        const now = new Date().getTime();
        if (now - this.timeCheckSendMessage < 1000) {
          return;
        }
        this.timeCheckSendMessage = now;
      }

      // Set the processing
      this.processing = true;

      try {
        // Get the first message
        const messageObj = this.messageCurrent[0];
        let messageSend = messageObj.message;

        // Check if message is too long to split message into multiple message
        if (messageObj.message.length > 4090) {
          if (messageObj?.isCountinue) {
            messageSend =
              "```json" + messageObj.message.substring(0, 4090) + "```";
          } else {
            messageSend = messageObj.message.substring(0, 4090) + "```";
          }
        } else {
          if (messageObj?.isCountinue) {
            messageSend = "```json" + messageObj.message;
          }
        }

        const success = await this.sendMessage(messageSend);

        if (success) {
          // Update message current if message is too long
          // or remove the first message
          if (messageObj.message.length > 4090) {
            messageObj.message = messageObj.message.substring(4090);
            messageObj.isCountinue = true;
          } else {
            // Remove the first message
            this.messageCurrent.shift();
          }
        }

        // Clear the processing
        this.processing = false;

        return success;
      } catch (error) {
        // Clear the processing
        this.processing = false;
        console.log("RocketChat send message current error: ", error);
      }
    } finally {
      // Unlock biến messageCurrent
      release();
      this.isSendOneMessageProcessing = false;
    }
  }
}

module.exports = RocketChatManager;
