import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createLinkFaviconReader,
  retainLinkFaviconCache,
  type LinkFaviconFetcher,
} from "./link-favicon-cache.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(fetch: LinkFaviconFetcher = async () => "blob:favicon") {
  const fetcher = vi.fn(fetch);
  const settled = createDeferred();
  const onSettled = vi.fn(settled.resolve);
  const reader = createLinkFaviconReader(onSettled);
  const revoke = vi.spyOn(URL, "revokeObjectURL");
  const read = () => reader.read("example.com", fetcher);
  return { fetcher, onSettled, reader, revoke, read, settled: settled.promise };
}

it("reuses a favicon across row remounts until its transcript is disposed", async () => {
  const { fetcher, reader, revoke, read, settled } = fixture();
  const releaseTranscript = retainLinkFaviconCache(fetcher);
  read();
  await settled;
  reader.dispose();
  expect(revoke).not.toHaveBeenCalled();
  const remounted = createLinkFaviconReader(() => undefined);
  expect(remounted.read("example.com", fetcher)).toBe("blob:favicon");
  expect(fetcher).toHaveBeenCalledOnce();
  releaseTranscript();
  expect(revoke).not.toHaveBeenCalled();
  remounted.dispose();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:favicon");
});

it("bounds unused warm favicons while keeping displayed images alive", async () => {
  const { fetcher, reader: visible, revoke, read } = fixture(async (host) => `blob:${host}`);
  const releaseTranscript = retainLinkFaviconCache(fetcher);
  read();
  for (let index = 0; index < 129; index++) {
    const settled = createDeferred();
    const reader = createLinkFaviconReader(settled.resolve);
    reader.read(`${index}.example.com`, fetcher);
    await settled.promise;
    reader.dispose();
  }
  expect(revoke).toHaveBeenCalledTimes(2);
  expect(revoke).not.toHaveBeenCalledWith("blob:example.com");
  releaseTranscript();
  visible.dispose();
  expect(revoke).toHaveBeenCalledTimes(130);
});
it("does not reuse a hostname miss across Gateway credential contexts", async () => {
  const { fetcher, reader, read, settled } = fixture(async () => null);
  read();
  await settled;
  expect(read()).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  const replacement = vi.fn<LinkFaviconFetcher>().mockResolvedValue("blob:replacement");
  expect(reader.read("example.com", replacement)).toBeUndefined();
  await vi.waitFor(() => expect(reader.read("example.com", replacement)).toBe("blob:replacement"));
  reader.dispose();
});

it("shares one request and URL until the last mounted reader releases it", async () => {
  const pending = createDeferred<string | null>();
  const { fetcher, onSettled, reader: first, revoke, read } = fixture(() => pending.promise);
  const anotherSubscriber = vi.fn();
  const second = createLinkFaviconReader(anotherSubscriber);
  expect(read()).toBeUndefined();
  expect(read()).toBeUndefined();
  expect(second.read("example.com", fetcher)).toBeUndefined();
  expect(fetcher).toHaveBeenCalledExactlyOnceWith("example.com", expect.any(AbortSignal));
  first.dispose();
  pending.resolve("blob:cached-favicon");
  await vi.waitFor(() => expect(anotherSubscriber).toHaveBeenCalledOnce());

  expect(onSettled).not.toHaveBeenCalled();
  expect(second.read("example.com", fetcher)).toBe("blob:cached-favicon");
  expect(fetcher).toHaveBeenCalledOnce();
  expect(revoke).not.toHaveBeenCalled();
  second.dispose();
  second.dispose();
  expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-favicon");
});

it("aborts an unowned request and revokes a late result without retaining its reader", async () => {
  const pending = createDeferred<string | null>();
  const { fetcher, onSettled, reader, revoke, read } = fixture(() => pending.promise);
  read();
  const signal = fetcher.mock.calls[0]![1];
  reader.dispose();
  expect(signal.aborted).toBe(true);
  pending.resolve("blob:late-favicon");
  await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late-favicon"));
  expect(onSettled).not.toHaveBeenCalled();
});

it("aborts a stalled fetch after 15 seconds and settles as a known failure", async () => {
  vi.useFakeTimers();
  const { fetcher, onSettled, reader, read } = fixture(
    (_hostname, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
  );
  expect(read()).toBeUndefined();
  const signal = fetcher.mock.calls[0]![1];
  await vi.advanceTimersByTimeAsync(14_999);
  expect(signal.aborted).toBe(false);
  expect(onSettled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(signal.aborted).toBe(true);
  expect(onSettled).toHaveBeenCalledOnce();
  expect(read()).toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
  reader.dispose();
});
