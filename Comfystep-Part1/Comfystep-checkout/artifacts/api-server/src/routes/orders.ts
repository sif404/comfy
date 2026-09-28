import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, ordersTable } from "@workspace/db";
import { CreateOrderBody, GetOrderResponse } from "@workspace/api-zod";
import { createStoredOrder, parseOrderToken, retryUnsyncedOrders, syncOrder, toOrderResponse } from "../lib/orders";

const router: IRouter = Router();
const rateLimitWindowMs = 10 * 60 * 1000;
const rateLimitMax = 5;
const requestsByIp = new Map<string, { count: number; resetAt: number }>();

function requestIp(req: { headers: Record<string, string | string[] | undefined>; ip?: string }) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip ?? "unknown";
}

function isRateLimited(ip: string) {
  const now = Date.now();
  const current = requestsByIp.get(ip);
  if (!current || current.resetAt <= now) {
    requestsByIp.set(ip, { count: 1, resetAt: now + rateLimitWindowMs });
    return false;
  }
  current.count += 1;
  return current.count > rateLimitMax;
}

router.post("/orders", async (req, res): Promise<void> => {
  if (isRateLimited(requestIp(req))) {
    res.status(429).json({ error: "تم تجاوز عدد المحاولات. حاول بعد قليل." });
    return;
  }

  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "يرجى التأكد من المعلومات المدخلة." });
    return;
  }
  if (parsed.data.honeypot?.trim()) {
    res.status(400).json({ error: "تعذر إرسال الطلب." });
    return;
  }

  try {
    const order = await createStoredOrder(parsed.data);
    const synced = await syncOrder(order);
    if (!synced) {
      req.log.warn({ orderNumber: order.orderNumber }, "Order saved without Sheet sync");
    }
    res.status(201).json(toOrderResponse(order));
  } catch (error) {
    if (error instanceof Error && error.message === "رمز الخصم غير صالح") {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Unable to create order");
    res.status(500).json({ error: "تعذر حفظ الطلب. حاول مرة أخرى." });
  }
});

router.get("/orders/:orderToken", async (req, res): Promise<void> => {
  const parsed = parseOrderToken(req.params.orderToken);
  if (!parsed.success) {
    res.status(404).json({ error: "الطلب غير موجود." });
    return;
  }

  const [order] = await db
    .select()
    .from(ordersTable)
    .where(eq(ordersTable.orderToken, parsed.data.orderToken));

  if (!order) {
    res.status(404).json({ error: "الطلب غير موجود." });
    return;
  }

  res.json(GetOrderResponse.parse(toOrderResponse(order)));
});

export default router;

export function startOrderSyncRetry() {
  void retryUnsyncedOrders();
  const interval = setInterval(() => {
    void retryUnsyncedOrders();
  }, 3 * 60 * 1000);
  interval.unref();
}