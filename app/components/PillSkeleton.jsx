// Tiny skeleton for the Unfulfilled pipeline pill while Shopify resolves.
// Polaris doesn't ship a SkeletonBadge, so we inline a shimmer div.
// Width matches a typical "PKR 12,400 · Unfulfilled" pill so the layout
// doesn't jump when the real badge swaps in.
export default function PillSkeleton() {
  return (
    <>
      <style>{`
        @keyframes pillShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      <div
        style={{
          width: 140,
          height: 22,
          borderRadius: 11,
          background:
            "linear-gradient(90deg, #f1f1f1 0%, #e3e3e3 50%, #f1f1f1 100%)",
          backgroundSize: "200% 100%",
          animation: "pillShimmer 1.4s infinite linear",
        }}
      />
    </>
  );
}
