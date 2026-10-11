import { SocketModeClient, LogLevel } from "@slack/socket-mode";
import { createHash } from "node:crypto";
import { slackConfig, type SlackConfig } from "./integration-config";
import { receiveSlack, decideSlack } from "./slack-events";
import { sendSlackDecision } from "./delivery";
import { sendSlackDecisionFeedback } from "./slack-feedback";
export async function startSlackListener() {
  let client: SocketModeClient | undefined,
    fingerprint = "",
    stopping = false,
    checking = false,
    connected = false,
    detail = "Slack not configured";
  const status = () => ({ connected, detail, updatedAt: Date.now() });
  async function refresh() {
    if (checking || stopping) return;
    checking = true;
    try {
      const config = await slackConfig();
      const socketEnabled =
        config?.appToken && config.deliveryMode !== "webhook";
      const hash = socketEnabled
        ? createHash("sha256").update(JSON.stringify(config)).digest("hex")
        : "";
      if (hash !== fingerprint) {
        await client?.disconnect();
        client = undefined;
        connected = false;
        fingerprint = hash;
        if (config?.appToken && socketEnabled) {
          client = new SocketModeClient({
            appToken: config.appToken,
            logger: {
              debug() {},
              info() {},
              warn() {},
              error() {},
              setLevel() {},
              getLevel() {
                return LogLevel.ERROR;
              },
              setName() {},
            },
          });
          client.on("error", () => {
            detail =
              "Slack connection error. Check app token and Socket Mode settings.";
          });
          client.on("connected", () => {
            connected = true;
            detail = "Socket Mode connected";
          });
          for (const event of ["disconnected", "reconnecting", "disconnecting"])
            client.on(event, () => {
              connected = false;
            });
          client.on("message", async ({ body, ack }) => {
            try {
              await receiveSlack(body, config);
              await ack();
            } catch {
              detail =
                "A Slack event could not be saved; provider retry may be required.";
            }
          });
          client.on("app_mention", async ({ body, ack }) => {
            try {
              await receiveSlack(body, config);
              await ack();
            } catch {
              detail =
                "A Slack mention could not be saved; provider retry may be required.";
            }
          });
          client.on("interactive", async ({ body, ack }) => {
            if (
              body.actions?.every((a: { action_id: string }) =>
                ["cue_open_cue", "cue_open_pr"].includes(a.action_id),
              )
            ) {
              await ack();
              return;
            }
            let current: SlackConfig | undefined;
            try {
              current = await slackConfig();
              if (!current) throw new Error("Slack disconnected");
              const decision = await decideSlack(body, current);
              await ack();
              if (decision)
                void sendSlackDecision(decision, body.message?.ts).catch(
                  () => {},
                );
            } catch (error) {
              await ack();
              if (current)
                void sendSlackDecisionFeedback(body, current, error).catch(
                  () => {},
                );
              detail =
                "Approval denied or already decided. Review the current commit or specification in Cue.";
            }
          });
          detail = "Connecting to Slack";
          await client.start();
        } else
          detail =
            config?.deliveryMode === "webhook"
              ? "Slack uses hosted HTTPS delivery"
              : "Add an app-level token to enable Socket Mode";
      }
    } catch {
      fingerprint = "";
      detail = "Slack setup could not be loaded";
    } finally {
      checking = false;
    }
  }
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  const stop = async () => {
    stopping = true;
    clearInterval(timer);
    await client?.disconnect();
    client = undefined;
    connected = false;
  };
  return { stop, status };
}
