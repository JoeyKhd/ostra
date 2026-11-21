import { openPage } from "../cdp/page.ts";
import { browserVersion, findBrowser, launchBrowser } from "../cdp/pipe.ts";
import { emptyStats, startScreencast } from "../sidecar/screencast.ts";

// A quick check that the pipe client drives this machine's browser, and of what the screencast's
// maxFramesInFlight and sendLastFrame do: with acks held to 2 a second, does the last change still arrive?

const executable = await findBrowser();
const cdp = await launchBrowser({ executable });
try {
  const version = await browserVersion(cdp);
  process.stdout.write(`browser ${version.product} ${executable}\n`);
  const page = await openPage(cdp, { width: 800, height: 600, mobile: false });
  await page.navigate("data:text/html,<body style='margin:0'><div id=b style='width:100px;height:100px;background:black'></div><p id=t>0</p></body>");
  for (const sendLastFrame of [false, true]) {
    const stats = emptyStats();
    const seen: { at: number; size: number }[] = [];
    const cast = await startScreencast(
      page,
      { format: "jpeg", quality: 60, maxWidth: 800, maxHeight: 600, inflight: 1, fpsCap: 2, capMode: "ack", sendLastFrame },
      (frame) => {
        seen.push({ at: frame.at, size: frame.data.length });
        return Promise.resolve();
      },
      stats,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    const before = seen.length;
    // 10 changes in 200 ms, then nothing: the last one must still reach the sink.
    for (let index = 1; index <= 10; index += 1) {
      await page.evaluate(`document.getElementById('t').textContent = '${String(index)}'; document.getElementById('b').style.background = '${index % 2 === 0 ? "black" : "white"}'`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const changedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await cast.stop();
    const after = seen.slice(before).map((frame) => frame.at - changedAt);
    process.stdout.write(`sendLastFrame=${String(sendLastFrame)}: frames after the burst ${String(after.length)} at ${after.join(",")} ms; produced ${String(stats.produced)}\n`);
  }
  await page.close();
} finally {
  await cdp.close();
}
