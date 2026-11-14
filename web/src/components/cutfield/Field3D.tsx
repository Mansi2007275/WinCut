"use client";

/**
 * The Cut Field: every settled trade as a pillar on a floor.
 *
 * The point of drawing it in three dimensions rather than as a bar chart is
 * that the fee has somewhere to go. A conventional chart can show that a fee
 * was small; it cannot show that the fee *left the pillar and arrived
 * somewhere*, which is the one claim this project is making. So:
 *
 *   x is time, z is market, y is realised P&L.
 *   A winning exit stands above the floor in green.
 *   A losing exit hangs below it in red, with a faint blue haze: the credit.
 *   The amber sliver on top of a winner is the fee, and it is the only amber
 *     thing on the screen. Three pieces break off it and fly to the three
 *     posts - trader, referrer, protocol - in the 50/20/30 ratio.
 *
 * When a winner was charged nothing because banked credit covered it, the
 * sliver is blue instead and nothing flies. That is not a rendering fallback:
 * it is the mechanism, and on this market it is what almost always happens.
 * A scene that invented an amber sliver there would be the one lie in the app.
 *
 * Everything is instanced. 500 trades is 500 pillars, and 500 draw calls on a
 * phone is a slideshow; eight instanced meshes is eight.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";

import { FLOOR_X, LANE_GAP, type FieldDatum, type Hover } from "./Field3D.types";

const COLORS = {
  profit: "#16c784",
  loss: "#ea3943",
  fee: "#f5a524",
  credit: "#5e86b8",
  buy: "#3a424c",
  grid: "#22272e",
  post: "#2b323b",
};

/** Where the fee's three pieces land, in the order the contract splits them. */
const POSTS = [
  { key: "trader", x: -2.6 },
  { key: "referrer", x: 0 },
  { key: "protocol", x: 2.6 },
] as const;

const POST_Z = 4.6;
const POST_Y = 2.2;

// ------------------------------------------------------------------ instances

const dummy = new THREE.Object3D();

/** Assigned to meshes that must never be hit-tested. */
const noRaycast = () => {};

/**
 * Instances allocated per mesh, fixed.
 *
 * It has to be fixed. `args` on an instancedMesh is constructor arguments:
 * react-three-fiber applies them once, when the object is created, and does
 * not rebuild it when they change. Sizing the buffer from `items.length` meant
 * the first render - with the ring still loading, so zero items - allocated a
 * single instance, and every later write of two hundred matrices ran off the
 * end of a buffer with room for one. That is not a React warning, it is a
 * renderer that stops responding.
 *
 * The contract's ring holds 500 trades, so 512 is the most any of these meshes
 * can ever need, and eight meshes of 512 instances is nothing to a GPU.
 */
const CAPACITY = 512;

/**
 * Capacity rounded up in steps, so the buffer is re-allocated rarely and is
 * never much bigger than the data. `args` is constructor-only, so growing it
 * means remounting the mesh - which is what the `key` on each one does.
 */
const bucket = (n: number): number => Math.min(CAPACITY, Math.max(64, Math.ceil(n / 64) * 64));

/** One instanced box set, positioned from a list of transforms. */
function Boxes({
  items,
  color,
  width,
  depth,
  opacity = 1,
  onHover,
}: {
  items: { x: number; y: number; z: number; h: number; i: number }[];
  color: string;
  width: number;
  depth: number;
  opacity?: number;
  /**
   * Omit it and the mesh opts out of raycasting entirely.
   *
   * This is the difference between a scene that orbits smoothly and one that
   * does not. react-three-fiber re-tests the pointer against the scene as the
   * camera moves, and every interactive instanced mesh costs its full instance
   * count on each of those tests. Seven of them at 512 instances is a quarter
   * of a million intersection tests a second, spent almost entirely on the
   * decorative layers - a fee slice sits on top of a pillar that already has
   * the same tooltip, and the credit haze has none at all.
   */
  onHover?: (index: number | null, event?: ThreeEvent<PointerEvent>) => void;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const size = bucket(items.length);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const drawn = Math.min(items.length, size);
    for (let n = 0; n < drawn; n++) {
      const it = items[n]!;
      dummy.position.set(it.x, it.y, it.z);
      dummy.scale.set(1, Math.max(Math.abs(it.h), 0.001), 1);
      dummy.updateMatrix();
      m.setMatrixAt(n, dummy.matrix);
    }
    m.count = drawn;
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [items, size]);

  if (!items.length) return null;
  return (
    <instancedMesh
      ref={mesh}
      key={size}
      args={[undefined, undefined, size]}
      raycast={onHover ? undefined : noRaycast}
      onPointerMove={
        onHover
          ? (e) => {
              e.stopPropagation();
              const n = e.instanceId;
              onHover(n === undefined ? null : (items[n]?.i ?? null), e);
            }
          : undefined
      }
      onPointerOut={onHover ? () => onHover(null) : undefined}
    >
      <boxGeometry args={[width, 1, depth]} />
      <meshStandardMaterial
        color={color}
        transparent={opacity < 1}
        opacity={opacity}
        roughness={0.55}
        metalness={0.05}
      />
    </instancedMesh>
  );
}

/** The fee's three pieces, in flight. One batch per charged fee. */
function FeeFlight({ data }: { data: FieldDatum[] }) {
  const group = useRef<THREE.Group>(null);
  // Only the most recent charged fees animate. A page that tries to animate
  // every fee in a 500-trade ring spends its frame budget on pieces nobody is
  // looking at.
  const charged = useMemo(() => data.filter((d) => d.feeHeight > 0).slice(-6), [data]);
  const shares = [0.5, 0.2, 0.3];

  useFrame(({ clock }) => {
    const g = group.current;
    if (!g) return;
    const t = clock.getElapsedTime();
    g.children.forEach((child, n) => {
      const batch = Math.floor(n / 3);
      const leg = n % 3;
      const d = charged[batch];
      if (!d) return;
      // Each piece runs its own loop, offset so the three do not move as one.
      const phase = (t * 0.35 + batch * 0.17 + leg * 0.08) % 1;
      const eased = phase * phase * (3 - 2 * phase);
      const from = new THREE.Vector3(d.x, d.height + d.feeHeight / 2, d.z);
      const to = new THREE.Vector3(POSTS[leg]!.x, POST_Y, POST_Z);
      child.position.lerpVectors(from, to, eased);
      // A lob rather than a straight line, so three pieces leaving one point
      // for three posts read as three paths.
      child.position.y += Math.sin(phase * Math.PI) * 1.1;
      const s = (0.07 + shares[leg]! * 0.1) * (1 - eased * 0.45);
      child.scale.setScalar(s);
      const mat = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
      mat.opacity = Math.sin(phase * Math.PI) * 0.95;
    });
  });

  if (!charged.length) return null;
  return (
    <group ref={group}>
      {charged.flatMap((d) =>
        shares.map((_, leg) => (
          <mesh key={`${d.trade.id}-${leg}`}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial color={COLORS.fee} transparent opacity={0.9} roughness={0.4} />
          </mesh>
        )),
      )}
    </group>
  );
}

/** Trader / referrer / protocol, as three posts the fee arrives at. */
function Posts({ lit }: { lit: boolean }) {
  return (
    <group>
      {POSTS.map((p) => (
        <mesh key={p.key} position={[p.x, POST_Y / 2, POST_Z]}>
          <boxGeometry args={[0.5, POST_Y, 0.5]} />
          <meshStandardMaterial
            color={lit ? COLORS.fee : COLORS.post}
            transparent
            opacity={lit ? 0.5 : 0.35}
            roughness={0.7}
          />
        </mesh>
      ))}
    </group>
  );
}

function Floor({ lanes }: { lanes: number }) {
  const depth = Math.max(lanes * LANE_GAP + 1.2, 3);
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]}>
        <planeGeometry args={[FLOOR_X * 2 + 2, depth]} />
        <meshBasicMaterial color="#0d1115" />
      </mesh>
      {/* The 1px rules, in world space: time across, one line per market. */}
      <gridHelper
        args={[FLOOR_X * 2 + 2, 24, COLORS.grid, COLORS.grid]}
        position={[0, 0.002, 0]}
      />
    </group>
  );
}

/** A slow orbit, and nothing else moving the camera. */
function Orbit({ paused }: { paused: boolean }) {
  useFrame(({ camera, clock }) => {
    if (paused) return;
    const a = clock.getElapsedTime() * 0.055;
    const r = 14.5;
    camera.position.set(Math.sin(a) * r, 7.2, Math.cos(a) * r);
    camera.lookAt(0, 0.6, 0);
  });
  return null;
}

// ---------------------------------------------------------------- the scene

function Scene({
  data,
  onHover,
  paused,
  lanes,
}: {
  data: FieldDatum[];
  onHover: (h: Hover) => void;
  paused: boolean;
  lanes: number;
}) {
  const pick = (index: number | null, e?: ThreeEvent<PointerEvent>) => {
    if (index === null || !e) return onHover(null);
    const d = data[index];
    if (!d) return onHover(null);
    onHover({ datum: d, screen: { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY } });
  };

  const buys = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.kind === "buy")
        .map(({ d, i }) => ({ x: d.x, y: d.height / 2, z: d.z, h: d.height, i })),
    [data],
  );
  const wins = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.kind === "win")
        .map(({ d, i }) => ({ x: d.x, y: d.height / 2, z: d.z, h: d.height, i })),
    [data],
  );
  const losses = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.kind === "loss")
        .map(({ d, i }) => ({ x: d.x, y: d.height / 2, z: d.z, h: Math.abs(d.height), i })),
    [data],
  );
  const feeSlices = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.feeHeight > 0)
        .map(({ d, i }) => ({ x: d.x, y: d.height + d.feeHeight / 2, z: d.z, h: d.feeHeight, i })),
    [data],
  );
  const shelteredSlices = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.sheltered)
        .map(({ d, i }) => ({ x: d.x, y: d.height + 0.055, z: d.z, h: 0.11, i })),
    [data],
  );
  const haze = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.kind === "loss")
        .map(({ d, i }) => ({ x: d.x, y: d.height - 0.18, z: d.z, h: 0.3, i })),
    [data],
  );
  const agents = useMemo(
    () =>
      data
        .map((d, i) => ({ d, i }))
        .filter(({ d }) => d.actor === "agent" && d.kind !== "buy")
        .map(({ d, i }) => ({
          x: d.x,
          y: d.height + (d.height >= 0 ? 0.26 : -0.26),
          z: d.z,
          h: 0.18,
          i,
        })),
    [data],
  );

  return (
    <>
      <ambientLight intensity={0.85} />
      <directionalLight position={[6, 12, 8]} intensity={1.1} />
      <directionalLight position={[-8, 5, -6]} intensity={0.35} />

      <Floor lanes={lanes} />
      <Posts lit={feeSlices.length > 0} />
      <Orbit paused={paused} />

      <Boxes items={buys} color={COLORS.buy} width={0.1} depth={0.1} onHover={pick} />
      <Boxes items={wins} color={COLORS.profit} width={0.17} depth={0.17} onHover={pick} />
      <Boxes items={losses} color={COLORS.loss} width={0.17} depth={0.17} onHover={pick} />
      <Boxes items={feeSlices} color={COLORS.fee} width={0.21} depth={0.21} />
      <Boxes items={shelteredSlices} color={COLORS.credit} width={0.21} depth={0.21} />
      <Boxes items={haze} color={COLORS.credit} width={0.34} depth={0.34} opacity={0.14} />
      <Boxes items={agents} color="#e6e8eb" width={0.13} depth={0.13} />

      <FeeFlight data={data} />
    </>
  );
}

export default function Field3D({
  data,
  lanes,
  onHover,
  paused = false,
  onError,
}: {
  data: FieldDatum[];
  lanes: number;
  onHover: (h: Hover) => void;
  paused?: boolean;
  onError?: () => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (failed) onError?.();
  }, [failed, onError]);

  if (failed) return null;
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 7.2, 14.5], fov: 42 }}
      gl={{ antialias: true, powerPreference: "low-power" }}
      onCreated={({ gl }) => {
        gl.setClearColor("#0b0e11", 1);
      }}
      // A context that cannot be created, or is lost later, must not leave a
      // blank rectangle where the centrepiece was.
      onPointerMissed={() => onHover(null)}
      fallback={null}
      onError={() => setFailed(true)}
    >
      <Scene data={data} onHover={onHover} paused={paused} lanes={lanes} />
    </Canvas>
  );
}
