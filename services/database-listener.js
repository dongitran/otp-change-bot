const fs = require("fs");
const path = require("path");
const { getDifferences } = require("../functions/get-diff-json");
const { setupDatabase } = require("../functions/setup-db");
const { sanitizeJson } = require("../functions/sanitize-json");
const escapeMarkdown = require("../functions/escape-markdown");

exports.databaseListener = async (telegramManager, rocketChatManager) => {
  // Initialize the clients for the databases
  const postgresClients = [];
  // Load database configurations
  const dbConfigs = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../config.json"), "utf-8")
  );

  // TODO: add try catch and retry
  for (const configs of dbConfigs) {
    switch (configs?.type) {
      case "postgres": {
        for (const config of configs?.configs) {
          const client = await setupDatabase(config);
          postgresClients.push(client);
        }

        for (const client of postgresClients) {
          client.query("LISTEN tbl_changes");

          client.on("notification", async (msg) => {
            const payload = JSON.parse(msg.payload);
            const tableName = payload?.table_name;
            const databaseName = payload?.database_name;
            console.log({ databaseName, tableName })
            if (
              tableName !== process.env.OTP_TABLE_NAME ||
              !process.env.OTP_DB_NAME.split(",").includes(databaseName)
            ) {
              return;
            }
            const action = payload.action;

            // Find the config for the database that sent the notification
            // and send the notification to the Telegram topic

            let message = "";
            let dataChange;
            const table = (payload?.table_name || "").replace(/_/g, `\\_`);
            switch (String(action).toUpperCase()) {
              case "INSERT": {
                dataChange = payload.data;
                message = `Insert *${table}*:\n\`\`\`json\n${JSON.stringify(
                  sanitizeJson(payload.data),
                  null,
                  2
                )}\n\`\`\``;

                break;
              }
              case "UPDATE": {
                const newData = payload?.new_data || [];
                const oldData = payload?.old_data || [];
                const updateData = {
                  id: payload?.new_data?.id,
                  ...getDifferences(oldData, newData),
                };
                dataChange = updateData;
                message = `Update *${table}*:\n\`\`\`json\n${JSON.stringify(
                  updateData,
                  null,
                  2
                )}\n\`\`\``;

                break;
              }
            }

            try {
              if (
                process.env.OTP_DB_NAME.split(",").includes(databaseName) &&
                payload?.table_name === process.env.OTP_TABLE_NAME &&
                dataChange?.code
              ) {
                const client = await setupDatabase(
                  {
                    user: process.env.OTP_DB_USERNAME,
                    password: process.env.OTP_DB_PASSWORD,
                    host: process.env.OTP_DB_HOST,
                    database: databaseName,
                    port: process.env.OTP_DB_PORT,
                  },
                  false
                );

                const result = await client.query(
                  `select * from ${process.env.OTP_TABLE_NAME} where id = ${dataChange?.id}`
                );
                const otpData = result?.rows[0];
                const code = otpData?.code;
                const email = otpData?.identification_value;
                
                const emailEscaped = escapeMarkdown(email);
                const telegramMessage = emailEscaped + " \\-\\-\\> `" + code + "`";
                await telegramManager.appendMessage(
                  telegramMessage,
                  process.env.TELEGRAM_GROUP_ID,
                  undefined
                );

                const rocketChatMessage = email + " --> " + code;
                await rocketChatManager.appendMessage(rocketChatMessage);

                client.end();
              }
            } catch (error) {
              console.log("errorSendOtp: ", error);
            }
          });
        }
        break;
      }
    }
  }
};
