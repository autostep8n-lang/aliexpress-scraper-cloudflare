import { runScheduledAutomation } from "./discovery/scheduled";
import type { Env } from "./env";
import { runAutomatedReports } from "./reports";
import { routeRequest } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const automation = await runScheduledAutomation(env, ctx, {
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
    });
    // The digest is derived from the completed run and never feeds back into it.
    await runAutomatedReports(env, automation);
  },
} satisfies ExportedHandler<Env>;
