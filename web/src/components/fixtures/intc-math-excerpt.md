# INTC math excerpt (fixture)

- Foundry：情景价值 + 概率加权中枢 \(E[P_f]\)（事件后改概率）
- **\(L\)** = 仅 CPU 下沿
- **\(M\)** = \(P_{\text{ref}}\) = CPU 中位 + \(E[P_f]\)
- 示意：\(L\approx 44\)，\(M\approx 91\)，\(H\approx 137\)
- 增发约 **$95**；现价约 **$89.5**

**公司锚点 — 不对称 SOTP**

\[
L = P_{\text{cpu},L}
\quad\text{（Foundry = 0）}
\]

\[
M = P_{\text{ref}} \approx P_{\text{cpu, mid}} + E[P_f]
\]

\[
H = P_{\text{cpu},H} + P_{\text{foundry, success}}
\]

切点 \(A=(L+M)/2\approx\) **67.5** · \(B=(M+H)/2\approx\) **114**

| zone | 区间 |
|------|------|
| `deep_discount` | \(P < 44\) |
| `conservative` | \([44,\ 67.5)\) |
