'use strict';
// Draining a child's stdout after it exited. The pipe only reaches EOF when EVERY holder of the write end has
// closed it, and a child can leave grandchildren that inherited it (WebKit helpers, the app-owned daemon winding
// down): waiting for EOF then races with a process that has nothing left to say. Once the child has exited, every
// byte it wrote is already in the pipe, so «drained» means: EOF, or no new data for `quietMs`.
function drained(child, { quietMs = 400, maxMs = 10000, now = Date.now, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  return (async () => {
    let last = now();
    const onData = () => { last = now(); };
    child.stdout.on('data', onData);
    try {
      const began = now();
      while (now() - began < maxMs) {
        if (child.stdout.readableEnded) return 'ended';
        if (now() - last >= quietMs) return 'quiet';
        await pause(25);
      }
      return 'timeout';
    } finally { child.stdout.off('data', onData); }
  })();
}
module.exports = { drained };
