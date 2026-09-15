import { runScheduledAutomation } from "./discovery/scheduled";
import type { Env } from "./env";
import { routeRequest } from "./router";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return routeRequest(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await runScheduledAutomation(env, ctx, { cron: controller.cron, scheduledTime: controller.scheduledTime });
  },
} satisfies ExportedHandler<Env>;
