export interface SamplePreset {
  id: string;
  title: string;
  language: string;
  leftText: string;
  rightText: string;
}

export const SAMPLE_PRESETS: SamplePreset[] = [
  {
    id: 'java-pathfinding',
    title: 'BreachController.java',
    language: 'java',
    leftText: `        forward=Vec3.directionFromRotation(0,rot.getYRot());
        Vec3 side=new Vec3(-forward.z,0,forward.x);
        if (tryBreach(rot,flight,observed,now)) return;
        // Commit to a clear waypoint for several ticks instead of alternating sides at the wall.
        Vec3[] directions={forward,side,side.scale(-1),forward.add(side).normalize(),
                forward.subtract(side).normalize(),new Vec3(0,1,0),new Vec3(0,-1,0)};
        double best=-Double.MAX_VALUE;
        for (Vec3 direction : directions) {
            Vec3 step=clearTravel(rot,direction.scale(8));
            if (step.lengthSqr()<4) continue;
            Vec3 goal=rot.position().add(step);
            double score=step.length()*.25;
            if (observed!=null) score+=rot.position().distanceTo(observed)-goal.distanceTo(observed);
            if (flight.lastSearchPoint!=null) score-=Math.max(0,8-goal.distanceTo(flight.lastSearchPoint));
            if (score>best) { best=score; flight.waypoint=goal; flight.corridor=step.length(); }
        }
        if (flight.waypoint!=null) flight.lastSearchPoint=rot.position();
    }

    private static boolean tryBreach(RotEntity rot, Flight flight, Vec3 observed, long now) {
        if (observed==null || !RotCopiedCombat.ENABLE_DASH || !RotCopiedCombat.AUTO_USE || !canUse(rot,2)
                || RotThunderclap.busy(rot) || now<value(rot.getPersistentData(),"rot_copied_combat_ready",0)
                || flightPath(rot,observed,false)) return false;
        Vec3 exit=breachExit(rot,observed);`,
    rightText: `        forward=Vec3.directionFromRotation(0,rot.getYRot());
        Vec3 side=new Vec3(-forward.z,0,forward.x);

        // Commit to a clear waypoint for several ticks instead of alternating sides at the wall.
        Vec3[] directions={forward,side,side.scale(-1),forward.add(side).normalize(),
                forward.subtract(side).normalize(),new Vec3(0,1,0),new Vec3(0,-1,0)};
        double best=-Double.MAX_VALUE;
        for (Vec3 direction : directions) {
            Vec3 step=clearTravel(rot,direction.scale(8));
            if (step.lengthSqr()<4) continue;
            Vec3 goal=rot.position().add(step);
            double score=step.length()*.25;
            if (observed!=null) score+=rot.position().distanceTo(observed)-goal.distanceTo(observed);
            if (flight.lastSearchPoint!=null) score-=Math.max(0,8-goal.distanceTo(flight.lastSearchPoint));
            if (score>best) { best=score; flight.waypoint=goal; flight.corridor=step.length(); }
        }
        if (flight.waypoint!=null) flight.lastSearchPoint=rot.position();
    }

    private static boolean tryBreach(RotEntity rot, Flight flight, Vec3 observed, long now) {
        if (observed==null || now<flight.nextBreachCheck || !RotCopiedCombat.ENABLE_DASH || !RotCopiedCombat.AUTO_USE || !canUse(rot,2)
                || RotThunderclap.busy(rot) || now<value(rot.getPersistentData(),"rot_copied_combat_ready",0)) return false;
        flight.nextBreachCheck=now+5;
        Vec3 exit=breachExit(rot,observed);`,
  },
  {
    id: 'ts-cache-refactor',
    title: 'rateLimiter.ts',
    language: 'typescript',
    leftText: `export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

export class MemoryRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly config: RateLimitConfig) {}

  allow(key: string, now = Date.now()): boolean {
    const timestamps = this.hits.get(key) ?? [];
    const active = timestamps.filter((t) => now - t < this.config.windowMs);
    if (active.length >= this.config.maxRequests) {
      this.hits.set(key, active);
      return false;
    }
    active.push(now);
    this.hits.set(key, active);
    return true;
  }
}`,
    rightText: `export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  burstAllowance?: number;
}

export class MemoryRateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly config: RateLimitConfig) {}

  allow(key: string, now = Date.now()): { allowed: boolean; remaining: number } {
    const limit = this.config.maxRequests + (this.config.burstAllowance ?? 0);
    const timestamps = this.hits.get(key) ?? [];
    const active = timestamps.filter((t) => now - t < this.config.windowMs);

    if (active.length >= limit) {
      this.hits.set(key, active);
      return { allowed: false, remaining: 0 };
    }

    active.push(now);
    this.hits.set(key, active);
    return { allowed: true, remaining: limit - active.length };
  }

  prune(now = Date.now()): void {
    for (const [key, list] of this.hits.entries()) {
      const valid = list.filter((t) => now - t < this.config.windowMs);
      if (valid.length === 0) this.hits.delete(key);
      else this.hits.set(key, valid);
    }
  }
}`,
  },
];

export async function encodeShareHash(payload: {
  title: string;
  language: string;
  leftText: string;
  rightText: string;
}): Promise<string> {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);

  if (typeof CompressionStream !== 'undefined') {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    await writer.write(bytes);
    await writer.close();
    const compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    let binary = '';
    for (let i = 0; i < compressed.length; i++) {
      binary += String.fromCharCode(compressed[i]);
    }
    const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `z.${b64}`;
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `r.${b64}`;
}

export async function decodeShareHash(
  hashValue: string
): Promise<{ title: string; language: string; leftText: string; rightText: string } | null> {
  try {
    const clean = hashValue.replace(/^#/, '');
    if (!clean.startsWith('diff=')) return null;
    const token = clean.slice(5);
    const [mode, b64] = token.split('.');
    if (!b64) return null;

    const padded = b64.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64.length + 3) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    if (mode === 'z' && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      await writer.write(bytes);
      await writer.close();
      const decompressed = new Uint8Array(await new Response(ds.readable).arrayBuffer());
      return JSON.parse(new TextDecoder().decode(decompressed));
    }

    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
