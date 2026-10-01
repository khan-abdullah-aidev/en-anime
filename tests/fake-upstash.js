// An in-memory stand-in for Upstash's REST API: one command per POST, or
// several through /pipeline. Only the commands En uses. Shared by the unit
// tests and the browser tests' storage server (e2e/fake-upstash-server.js).
export function createFakeUpstash() {
  const strings = new Map();
  const lists = new Map();

  function run([command, ...args]) {
    switch (String(command).toUpperCase()) {
      case "GET":
        return strings.get(args[0]) ?? null;
      case "SET": {
        const [key, value, ...options] = args;
        if (options.includes("NX") && strings.has(key)) return null;
        strings.set(key, value);
        return "OK";
      }
      case "DEL": {
        let removed = 0;
        for (const key of args) {
          if (strings.delete(key)) removed += 1;
          if (lists.delete(key)) removed += 1;
        }
        return removed;
      }
      case "RPUSH": {
        const [key, ...values] = args;
        const list = lists.get(key) || [];
        list.push(...values);
        lists.set(key, list);
        return list.length;
      }
      case "LRANGE": {
        const list = lists.get(args[0]) || [];
        const stop = Number(args[2]);
        return list.slice(Number(args[1]), stop === -1 ? undefined : stop + 1);
      }
      case "LTRIM": {
        // Only the (-N, -1) form: keep the last N.
        const list = lists.get(args[0]) || [];
        lists.set(args[0], list.slice(Math.max(0, list.length + Number(args[1]))));
        return "OK";
      }
      case "EXPIRE":
        return 1;
      default:
        throw new Error(`fake upstash: unknown command ${command}`);
    }
  }

  const answer = (command) => {
    try {
      return { result: run(command) };
    } catch (error) {
      return { error: error.message };
    }
  };

  return {
    strings,
    lists,
    // The JSON Upstash would send back for this request.
    respond(url, body) {
      return String(url).endsWith("/pipeline") ? body.map(answer) : answer(body);
    }
  };
}
