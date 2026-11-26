import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { nativeHostContract } from "./native-host-contract.js";
const execute = promisify(execFile);
const epoch = randomUUID();
// The worker never creates, replaces or unlinks the lock inode. Enrollment is
// deliberately separate; a missing local configuration is an unknown worker.
const configSchema = z.object({ generation: z.string().min(1) }).strict();
export const nativeLockProbe = `import fcntl, os, sys, json
fd=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW)
result={'lock':'unknown','threadId':None}
try:
 try:
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  result['lock']='free'
 except BlockingIOError:
  result['lock']='held'
  try:
   r=json.load(open(os.path.join(os.path.dirname(sys.argv[1]),'native-holder.json')))
   stat=os.fstat(fd)
   live=open('/proc/%d/stat'%r['pid']).read().rsplit(')',1)[1].split()[19]
   boot=open('/proc/sys/kernel/random/boot_id').read().strip()
   held=False
   for line in open('/proc/locks'):
    fields=line.split()
    if len(fields)<6 or fields[1]!='FLOCK' or fields[3]!='WRITE': continue
    major,minor,inode=fields[5].split(':')
    if int(fields[4])==r['pid'] and int(inode)==stat.st_ino and int(major,16)==os.major(stat.st_dev) and int(minor,16)==os.minor(stat.st_dev): held=True
   if held and live==r['start'] and boot==r['boot'] and stat.st_ino==r['inode'] and stat.st_dev==r['device'] and isinstance(r['threadId'],str): result['threadId']=r['threadId']
  except (OSError,ValueError,KeyError,TypeError): pass
finally:
 os.close(fd)
print(json.dumps(result))
`;
export default experimental_defineHostEntry({
  contract: nativeHostContract,
  handlers: {
    async status(_input, context) {
      let generation = "unconfigured";
      try {
        const config = configSchema.parse(
          JSON.parse(
            await readFile(
              path.join(
                context.experimental_paths.dataDir,
                "native-worker.json",
              ),
              "utf8",
            ),
          ),
        );
        generation = config.generation;
        const result = await execute(
          "/usr/bin/python3",
          [
            "-c",
            nativeLockProbe,
            path.join(context.experimental_paths.dataDir, "native.lock"),
          ],
          { signal: context.signal, timeout: 5000, maxBuffer: 1024 },
        );
        const observation = z
          .object({
            lock: z.enum(["held", "free", "unknown"]),
            threadId: z.string().nullable(),
          })
          .parse(JSON.parse(result.stdout));
        return { generation, epoch, ...observation };
      } catch {
        return { generation, epoch, lock: "unknown" as const, threadId: null };
      }
    },
  },
});
