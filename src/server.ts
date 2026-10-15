import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";

const app = express();

const PORT = Number(process.env.PORT ?? 3001);

const DELAY_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const PEER_URL = requireEnv("PEER_URL").replace(/\/+$/, "");
const LOOP_SECRET = requireEnv("LOOP_SECRET");

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;

// Authenticate requests coming from the other server or your trigger.
function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.header("x-loop-secret") !== LOOP_SECRET) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

// Call Server B immediately.
async function callPeer(): Promise<void> {
  const response = await fetch(`${PEER_URL}/tick`, {
    method: "POST",
    headers: {
      "x-loop-secret": LOOP_SECRET,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Server B returned HTTP ${response.status}`);
  }
}

// Schedule a call without keeping an HTTP request open.
function scheduleNext(delayMs: number = DELAY_MS): void {
  if (timer !== null) {
    console.log("A timer is already scheduled; ignoring duplicate tick.");
    return;
  }

  console.log(
    `Server A will call Server B in ${Math.round(delayMs / 1000)} seconds.`,
  );

  timer = setTimeout(() => {
    timer = null;
    void runScheduledCall();
  }, delayMs);
}

// Perform a scheduled call to Server B.
async function runScheduledCall(): Promise<void> {
  if (inFlight) {
    scheduleNext(RETRY_MS);
    return;
  }

  inFlight = true;
  let failed = false;

  try {
    await callPeer();

    console.log(
      `${new Date().toISOString()} - Server A successfully called Server B`,
    );
  } catch (error: unknown) {
    failed = true;

    console.error(
      "Server A could not call Server B:",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    inFlight = false;

    if (failed) {
      scheduleNext(RETRY_MS);
    }
  }
}

// Health check for Render.
app.get("/health", (_req: Request, res: Response): void => {
  res.status(200).send("Server A is running.");
});

// FUNCTION 1: Trigger the loop by immediately calling Server B.
app.post(
  "/trigger",
  authenticate,
  async (_req: Request, res: Response): Promise<void> => {
    if (inFlight) {
      res.status(409).json({
        success: false,
        message: "A call is already in progress.",
      });
      return;
    }

    inFlight = true;
    let failed = false;

    try {
      await callPeer();

      console.log("Initial trigger sent from Server A to Server B.");

      res.status(202).json({
        success: true,
        message: "Server B was called. The loop has been triggered.",
      });
    } catch (error: unknown) {
      failed = true;

      console.error(
        "Initial call failed:",
        error instanceof Error ? error.message : String(error),
      );

      res.status(502).json({
        success: false,
        message: "Server B is unavailable. A retry was scheduled.",
      });
    } finally {
      inFlight = false;

      if (failed) {
        scheduleNext(RETRY_MS);
      }
    }
  },
);

// FUNCTION 2: Server B calls this endpoint.
// Server A waits 5 minutes, then calls Server B.
app.post(
  "/tick",
  authenticate,
  (_req: Request, res: Response): void => {
    scheduleNext();

    res.status(202).json({
      success: true,
      message: "Server A received the tick and scheduled its next call.",
    });
  },
);

app.listen(PORT, () => {
  console.log(`Server A listening on port ${PORT}`);
  console.log(`Server A's peer is ${PEER_URL}`);
});