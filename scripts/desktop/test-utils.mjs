export async function closeTestApplication(electron) {
  let timer;
  try {
    await Promise.race([
      electron.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          electron.process().kill("SIGKILL");
          reject(new Error("Desktop application did not quit cleanly within 90 seconds"));
        }, 90_000);
      })
    ]);
  } finally { clearTimeout(timer); }
}
