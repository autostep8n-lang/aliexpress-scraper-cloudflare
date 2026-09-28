import { runScheduledAutomation } from "./discovery/scheduled";
import type { Env } from "./env";
import { logInfo } from "./logging";
import { runAutomatedReports } from "./reports";
import { routeRequest } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    logInfo("scheduled.entry", { cron: controller.cron, scheduledTime: controller.scheduledTime });
    const automation = await runScheduledAutomation(env, ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    // The digest is derived from the completed run and never feeds back into it.
    await runAutomatedReports(env, automation);
    logInfo("scheduled.exit", {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      discoveryStatus: automation.discovery.status,
      scoringStatus: automation.scoring ? automation.scoring.status : null,
      alertsStatus: automation.alerts ? automation.alerts.status : null,
    });
  },
} satisfies ExportedHandler<Env>;
