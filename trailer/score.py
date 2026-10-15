"""The trailer's score, synthesised from nothing: felt piano, koto, string
pads, taiko, rain. It reads the cue sheet from index.html, so every hit
lands on the frame it belongs to.

    python trailer/score.py        -> trailer/out/score.wav (48 kHz, -15 LUFS)
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
HERE = Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

html = (HERE / "index.html").read_text(encoding="utf-8")
C = json.loads(re.search(r'<script id="cues" type="application/json">(.*?)</script>', html, re.S).group(1))
DUR = C["duration"]
N = int((DUR + 0.2) * SR)

rng = np.random.default_rng(7)


# ——— helpers ———

NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hz(name):
    m = re.fullmatch(r"([A-G])([#b]?)(-?\d)", name)
    semi = NOTE[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    midi = 12 * (int(m.group(3)) + 1) + semi
    return 440.0 * 2 ** ((midi - 69) / 12)


def db(x):
    return 10 ** (x / 20)


def tt(n):
    return np.arange(n) / SR


def fft_filter(x, gain_fn):
    n = len(x)
    size = 1 << (n - 1).bit_length()
    spec = np.fft.rfft(x, size)
    f = np.fft.rfftfreq(size, 1 / SR)
    return np.fft.irfft(spec * gain_fn(f), size)[:n]


def lowpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def bandpass(x, lo, hi, order=2):
    return highpass(lowpass(x, hi, order), lo, order)


def stft_filter(x, gain_at, frame=2048, hop=512):
    """Filter whose response changes over time: gain_at(freqs, seconds)."""
    pad = np.concatenate([np.zeros(frame), x, np.zeros(frame)])
    win = np.hanning(frame)
    count = (len(pad) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    frames = pad[idx] * win
    spec = np.fft.rfft(frames, axis=1)
    f = np.fft.rfftfreq(frame, 1 / SR)
    centres = (hop * np.arange(count) + frame / 2 - frame) / SR
    gains = np.stack([gain_at(f, c) for c in centres])
    out_frames = np.fft.irfft(spec * gains, axis=1) * win
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    np.add.at(out, idx, out_frames)
    np.add.at(norm, idx, np.broadcast_to(win**2, out_frames.shape))
    out /= np.maximum(norm, 1e-3)
    return out[frame:frame + len(x)]


def movavg(x, w):
    c = np.cumsum(np.concatenate([np.zeros(w // 2 + 1), x, np.zeros(w)]))
    return (c[w:w + len(x)] - c[:len(x)]) / w


def pink(n):
    w = rng.standard_normal(n)
    return fft_filter(w, lambda f: 1 / np.sqrt(np.maximum(f, 20)))


def smooth_env(n, attack, release, hold_end=None):
    t = tt(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    a = 0.5 - 0.5 * np.cos(np.pi * a)
    end = n / SR
    r = np.clip((end - t) / max(release, 1e-4), 0, 1)
    r = 0.5 - 0.5 * np.cos(np.pi * r)
    return a * r


# ——— the mix ———

class Bus:
    def __init__(self):
        self.dry = np.zeros((2, N))
        self.send = np.zeros(N)

    def add(self, sig, at, gain_db=0.0, pan=0.0, send=0.25):
        start = int(round(at * SR))
        if start >= N:
            return
        g = db(gain_db)
        if sig.ndim == 1:
            sig = sig[: N - start]
            th = (pan + 1) * np.pi / 4
            self.dry[0, start:start + len(sig)] += sig * g * math.cos(th)
            self.dry[1, start:start + len(sig)] += sig * g * math.sin(th)
            self.send[start:start + len(sig)] += sig * g * send
        else:
            sig = sig[:, : N - start]
            self.dry[:, start:start + sig.shape[1]] += sig * g
            self.send[start:start + sig.shape[1]] += sig.mean(axis=0) * g * send


def make_ir(t60=3.4, bright_t60=1.0, pre=0.022, seed=3):
    r = np.random.default_rng(seed)
    n = int(t60 * 1.15 * SR)
    t = tt(n)
    chans = []
    for _ in range(2):
        w = r.standard_normal(n)
        low = lowpass(w, 1800, 1)
        high = w - low
        ir = low * np.exp(-6.9 * t / t60) + 0.55 * high * np.exp(-6.9 * t / bright_t60)
        ir *= 1 - np.exp(-t / 0.035)
        ir = np.concatenate([np.zeros(int(pre * SR)), ir])
        chans.append(ir / np.sqrt(np.sum(ir**2)))
    return chans


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]


def render_bus(bus, ir, wet_db=-4.0):
    wet = np.stack([convolve(bus.send, ir[0]), convolve(bus.send, ir[1])]) * db(wet_db)
    return bus.dry + wet


# ——— instruments ———

def felt_piano(f, dur=5.0, vel=0.6):
    """A felted upright: soft hammer, two strings a hair apart, upper partials fading fast."""
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros(n)
    B = 0.00038
    pitch = math.sqrt(f / 262)
    for k in range(1, 13):
        fk = f * k * math.sqrt(1 + B * k * k)
        if fk > 7000:
            break
        amp = (vel ** (0.4 * k)) / k**1.25
        decay = (0.32 + 0.55 * k**1.15) * (0.55 + 0.45 * pitch)
        for cents in (-0.7, 0.7):
            ph = rng.uniform(0, 2 * np.pi)
            out += 0.5 * amp * np.sin(2 * np.pi * fk * 2 ** (cents / 1200) * t + ph) * np.exp(-t * decay)
    hammer = lowpass(rng.standard_normal(n), 1400 + 1800 * vel) * np.exp(-t / 0.006) * 0.08 * vel
    out = (out + hammer) * (1 - np.exp(-t / 0.0035))
    out *= smooth_env(n, 0.001, 0.4)
    return out * vel / max(np.abs(out).max(), 1e-9)


def koto(f, dur=3.5, vel=0.7, bright=0.62, t60=2.4):
    """Karplus-Strong string, plucked near the bridge, with the koto's settle in pitch."""
    period = SR / f - 0.5
    ni = max(2, int(period))
    f0 = SR / (ni + 0.5)
    n = int(dur * SR)
    m = int(n * f / f0) + 4 * ni
    exc = rng.standard_normal(ni)
    exc = lowpass(np.concatenate([exc, np.zeros(ni)]), 1200 + 6000 * bright, 1)[:ni]
    exc = exc - np.roll(exc, max(1, int(ni * 0.14)))
    buf = np.zeros(m + 1)
    buf[1:ni + 1] = exc
    g = 10 ** (-3 / (t60 * f0))
    a = 0.5 + 0.35 * bright
    k = 1
    while k * ni < m:
        s = 1 + k * ni
        e = min(s + ni, m + 1)
        prev = buf[s - ni:e - ni]
        prev2 = buf[s - ni - 1:e - ni - 1]
        buf[s:e] = g * (a * prev + (1 - a) * prev2)
        k += 1
    y = buf[1:]
    # Retune to the exact pitch and add the small drop as the string settles.
    t = tt(n)
    cents = 18 * np.exp(-t / 0.05)
    rate = (f / f0) * 2 ** (cents / 1200)
    pos = np.cumsum(rate) - rate[0]
    out = np.interp(pos, np.arange(len(y)), y)
    body = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.5) * 0.12
    out = lowpass(out + body * np.abs(out).max(), 8500, 1)
    out *= smooth_env(n, 0.001, 0.5)
    return out * vel / max(np.abs(out).max(), 1e-9)


def pad(notes, dur, attack=1.6, release=2.2, bright=2200, voices=5, detune=9, vel=1.0, width=0.75):
    """Strings and warm synth in one: detuned, band-limited saws, slowly breathing."""
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros((2, n))
    for name in notes:
        f = hz(name) if isinstance(name, str) else name
        for v in range(voices):
            c = detune * (v - (voices - 1) / 2) / ((voices - 1) / 2)
            fv = f * 2 ** (c / 1200)
            sig = np.zeros(n)
            k = 1
            while fv * k < min(bright * 2.2, 9000) and k < 48:
                amp = (1 / k) / math.sqrt(1 + (fv * k / bright) ** 4)
                sig += amp * np.sin(2 * np.pi * fv * k * t + rng.uniform(0, 2 * np.pi))
                k += 1
            lfo = 1 + 0.08 * np.sin(2 * np.pi * (0.13 + 0.05 * v) * t + v)
            pan = ((v / (voices - 1)) * 2 - 1) * width
            th = (pan + 1) * np.pi / 4
            out[0] += sig * lfo * math.cos(th)
            out[1] += sig * lfo * math.sin(th)
    out *= smooth_env(n, attack, release)
    # Clear the mud: a dip around 250 Hz and nothing below 45 Hz.
    shape = lambda f: (1 - 0.55 * np.exp(-((np.log2(np.maximum(f, 1) / 260)) ** 2) / 0.5)) / np.sqrt(1 + (45 / np.maximum(f, 1)) ** 4)
    out = np.stack([fft_filter(out[0], shape), fft_filter(out[1], shape)])
    peak = np.abs(out).max()
    return out * vel / max(peak, 1e-9) * 0.9


def boom(dur=3.5, f_hi=78, f_lo=33, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.11)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.95)
    thump = lowpass(rng.standard_normal(n), 220, 2) * np.exp(-t / 0.05) * 0.9
    click = bandpass(rng.standard_normal(n), 900, 4000) * np.exp(-t / 0.004) * 0.15
    out = body + thump + click
    out *= 1 - np.exp(-t / 0.002)
    return out * vel / np.abs(out).max()


def taiko(vel=1.0, size=1.0):
    n = int(1.6 * SR)
    t = tt(n)
    f = 58 / size + 55 / size * np.exp(-t / 0.028)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.32 * size))
    skin = bandpass(rng.standard_normal(n), 140, 1100) * np.exp(-t / 0.045) * 0.55
    out = (body + skin) * (1 - np.exp(-t / 0.0015))
    return out * vel / np.abs(out).max()


def bell(f, dur=6.0, vel=0.5):
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros(n)
    for ratio, amp, dec in [(1, 1, 0.6), (2.0, 0.5, 1.1), (2.76, 0.35, 1.6), (4.07, 0.22, 2.4), (5.4, 0.12, 3.2), (0.5, 0.25, 0.5)]:
        out += amp * np.sin(2 * np.pi * f * ratio * t + rng.uniform(0, 6)) * np.exp(-t * dec)
    out *= 1 - np.exp(-t / 0.002)
    return out * vel / np.abs(out).max()


def tick(vel=1.0, tone=3200):
    n = int(0.03 * SR)
    t = tt(n)
    w = bandpass(rng.standard_normal(n), tone * 0.6, tone * 1.6)
    out = w * np.exp(-t / 0.0011) + 0.4 * np.sin(2 * np.pi * 210 * t) * np.exp(-t / 0.006)
    return out * vel / np.abs(out).max()


def key_tap(vel=1.0):
    n = int(0.08 * SR)
    t = tt(n)
    thock = np.sin(2 * np.pi * (170 + 90 * np.exp(-t / 0.004)) * t) * np.exp(-t / 0.014)
    clack = bandpass(rng.standard_normal(n), 1800, 6500) * np.exp(-t / 0.0025) * 0.6
    out = thock + clack
    return out * vel / np.abs(out).max()


def swish(dur=0.45, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    w = rng.standard_normal(n)
    out = stft_filter(w, lambda f, c: np.exp(-((np.log(np.maximum(f, 20)) - np.log(1500 + 5000 * max(0.0, min(1.0, c / dur)))) ** 2) / 0.35))
    out *= np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    return out * vel / np.abs(out).max()


def swell(dur, vel=1.0, lo=200, hi=9000):
    """Reverse-cymbal rise that ends exactly at its own end."""
    n = int(dur * SR)
    t = tt(n)
    w = rng.standard_normal(n)
    out = stft_filter(w, lambda f, c: 1 / (1 + (f / (lo + (hi - lo) * max(0.0, min(1.0, c / dur)) ** 2)) ** 4))
    out *= (t / dur) ** 3.2
    out *= smooth_env(n, 0.001, 0.012)
    return out * vel / np.abs(out).max()


def riser(dur, f_start, f_end, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    k = t / dur
    f = f_start * (f_end / f_start) ** (k**1.6)
    ph = 2 * np.pi * np.cumsum(f) / SR
    trem = 1 - 0.35 * (0.5 + 0.5 * np.sin(2 * np.pi * (3 + 18 * k**2) * t))
    out = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph * 1.003)) * trem * k**2.2
    return out * vel / np.abs(out).max()


def heart(vel=1.0):
    n = int(0.7 * SR)
    t = tt(n)
    one = np.sin(2 * np.pi * 52 * t) * np.exp(-t / 0.07)
    two = np.zeros(n)
    d = int(0.2 * SR)
    two[d:] = 0.65 * np.sin(2 * np.pi * 47 * t[: n - d]) * np.exp(-t[: n - d] / 0.08)
    out = (one + two) * (1 - np.exp(-t / 0.004))
    return out * vel / np.abs(out).max()


def rain(dur, vel=1.0):
    n = int(dur * SR)
    bed = bandpass(pink(n), 500, 7000, 1)
    bed /= np.abs(bed).max()
    drops = np.zeros(n)
    for _ in range(int(dur * 38)):
        at = rng.integers(0, n - 2000)
        L = int(SR * rng.uniform(0.004, 0.012))
        tl = tt(L)
        fdrop = rng.uniform(2200, 6000)
        drops[at:at + L] += np.sin(2 * np.pi * fdrop * tl * (1 + 0.6 * tl / tl[-1])) * np.exp(-tl / (L / SR / 4)) * rng.uniform(0.2, 1)
    out = 0.8 * bed + 0.25 * drops
    out *= smooth_env(n, 1.0, 1.4)
    return out * vel / np.abs(out).max()


# ——— the score ———

main = Bus()
act1 = Bus()
B = 60 / 70  # a slow seventy


def strum(bus, notes, at, gain_db, spread=0.03, pan=0.0, send=0.35, **kw):
    for i, name in enumerate(notes):
        bus.add(koto(hz(name), **kw), at + i * spread, gain_db - 1.5 * i, pan + 0.12 * (i - len(notes) / 2), send)


def piano(name, at, gain_db, vel=0.5, dur=5.0, pan=0.05, send=0.5, bus=None):
    (bus or main).add(felt_piano(hz(name), dur, vel), at, gain_db, pan=pan, send=send)


def drip(vel=1.0):
    n = int(0.12 * SR)
    t = tt(n)
    f = 900 + 1700 * (1 - np.exp(-t / 0.012))
    out = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.018)
    return out * vel / np.abs(out).max()


def sustained(name, dur, attack, release, vib=0.004):
    n = int(dur * SR)
    t = tt(n)
    v = 1 + vib * np.sin(2 * np.pi * 5.1 * t) * np.clip(t / 1.5, 0, 1)
    ph = 2 * np.pi * np.cumsum(hz(name) * v) / SR
    return (np.sin(ph) + 0.16 * np.sin(2 * ph) + 0.05 * np.sin(3 * ph)) * smooth_env(n, attack, release)


# I · 11:47 PM. A thousand shows.
act1.add(pad(["D2", "A2", "D3"], 11.2, attack=3.5, release=1.8, bright=520), 0.3, -26, send=0.3)
act1.add(pad(["E5", "A5", "D6"], 10.0, attack=3.5, release=2.0, bright=7000, detune=22, voices=4), 1.0, -38, send=0.7)
act1.add(bandpass(pink(int(11.5 * SR)), 200, 3000, 1) / 3 * smooth_env(int(11.5 * SR), 1.5, 2.0), 0.0, -45, send=0.0)
for at, name, vel, gain in [(C["clock"], "D3", 0.4, -12), (C["clock"] + 0.03, "A3", 0.38, -13),
                            (C["l1"], "F4", 0.5, -11), (C["l1"] + 0.75, "E4", 0.42, -12),
                            (C["l2"], "D4", 0.48, -11), (C["l2"] + 0.02, "Bb3", 0.4, -13), (C["l2"] + 0.9, "A3", 0.42, -12),
                            (C["clock2"], "A5", 0.35, -17), (C["clock2"] + 0.02, "D2", 0.45, -14)]:
    piano(name, at, gain, vel, bus=act1)
x = 1.8
while x < C["exhale"] + 0.6:
    act1.add(tick(rng.uniform(0.4, 0.9), tone=rng.uniform(2600, 4200)), x, -37, pan=rng.uniform(-0.6, 0.6), send=0.2)
    x += rng.uniform(0.25, 0.9)
# The exhale: everything sinks.
n = int(2.2 * SR)
sigh = stft_filter(rng.standard_normal(n), lambda f, c: 1 / (1 + (f / (6000 * (1 - min(1.0, max(0.0, c) / 2.2)) ** 2 + 150)) ** 4))
act1.add(sigh / np.abs(sigh).max() * np.sin(np.pi * np.clip(tt(n) / 2.2, 0, 1)) ** 2, C["exhale"], -27, send=0.3)

# II · How do you feel?
main.add(bandpass(pink(int(7 * SR)), 300, 2500, 1) / 3 * smooth_env(int(7 * SR), 1.0, 1.0), 11.4, -52, send=0)
piano("A4", C["ask"], -15, 0.35, send=0.6)
t_type = C["type"]
for i, ch in enumerate(C["typeText"]):
    d = 0.075 + 0.025 * math.sin(i * 12.9898) * math.sin(i * 4.1414)
    main.add(key_tap(rng.uniform(0.6, 1)), t_type, -22 if ch != " " else -25, pan=rng.uniform(-0.15, 0.15), send=0.1)
    if ch == " ":
        d += 0.04
    if ch in ".,":
        d += 0.36
    t_type += d
# The first drop, landing on "rain": a drip that rings like a string.
main.add(drip(1), C["dropLand"], -16, send=0.6)
main.add(koto(hz("A5"), 5, 0.6, bright=0.3, t60=4.0), C["dropLand"] + 0.01, -16, send=0.8)
main.add(rain(35.2 - C["dropLand"] + 1.5, 1), C["dropLand"] + 0.2, -26, send=0.08)
for k in range(9):
    main.add(drip(rng.uniform(0.3, 0.8)), C["dropLand"] + 0.6 + k * rng.uniform(0.15, 0.4), -30, pan=rng.uniform(-0.7, 0.7), send=0.3)

# III · The thread.
P = C["pull"]
main.add(koto(hz("D5"), 4, 0.7, bright=0.55, t60=3.0), P, -12, send=0.55)
main.add(swish(0.9), P - 0.1, -26, send=0.3)
main.add(sustained("A5", C["window"] - P + 2.0, 3.0, 2.0), P, -31, send=0.6)
journey_chords = [
    (P, C["c2"], ["D2", "A2", "D3", "F3", "A3", "E4"], 1500),
    (C["c2"], C["only"], ["Bb1", "F2", "Bb2", "D3", "F3", "A3", "E4"], 1600),
    (C["only"], C["world"] - 0.25, ["A1", "E2", "A2", "D3", "E3", "A3"], 1100),
]
for a, b, notes, br in journey_chords:
    main.add(pad(notes, b - a + 1.2, attack=2.0, release=1.2 if b < C["world"] - 1 else 0.15, bright=br), a, -18, send=0.4)
ost = ["D4", "A4", "E5", "A4", "F5", "A4", "E5", "A4"]
x = P + 0.6
i = 0
while x < C["only"] - 0.2:
    main.add(koto(hz(ost[i % 8]), 2.4, 0.6, bright=0.5, t60=1.8), x, -19 if i % 2 == 0 else -23, pan=0.3 if i % 2 else -0.3, send=0.35)
    x += B / 2
    i += 1
x = P + 2.0
while x < C["world"] - 0.6:
    main.add(heart(0.6), x, -25 + 6 * max(0.0, (x - C["only"]) / (C["world"] - C["only"])), send=0.05)
    x += B
for at, notes, sparkle in zip(C["loves"], [["A4", "E5"], ["C5"], ["E5"]], ["A5", "C6", "E6"]):
    for j, name in enumerate(notes):
        piano(name, at + 0.02 * j, -10, 0.55, send=0.55)
    main.add(bell(hz(sparkle), 3, 1), at, -26, pan=0.3, send=0.6)
for at in C["drops"]:
    main.add(swish(0.6), at, -24, pan=0.35, send=0.25)
    piano("D2", at + 0.9, -18, 0.4, send=0.4)
# Toward the one: rising into the light.
main.add(riser(C["world"] - 31.0, hz("A3"), hz("A5"), 1), 31.0, -22, send=0.4)
main.add(swell(C["world"] - C["window"], lo=200, hi=12000), C["window"], -11, send=0.25)

# IV · The one.
W0 = C["world"]
main.add(boom(5, vel=1), W0, -3, send=0.3)
main.add(taiko(1, 1.2), W0, -7, send=0.4)
for name, p in [("D5", -0.25), ("A5", 0.25), ("F#6", 0)]:
    main.add(bell(hz(name), 8, 1), W0, -20, pan=p, send=0.75)
strum(main, ["D3", "A3", "D4", "F#4", "A4", "D5"], W0, -10, bright=0.65, spread=0.035)
world_chords = [
    (W0, C["reasons"][1], ["D2", "A2", "D3", "F#3", "A3", "C#4", "E4"], 2600),
    (C["reasons"][1], C["reasons"][2], ["B1", "F#2", "B2", "D3", "F#3", "A3", "C#4"], 2400),
    (C["reasons"][2], C["one"] + 0.4, ["G1", "D2", "G2", "B2", "D3", "F#3", "A3"], 2200),
]
for k, (a, b, notes, br) in enumerate(world_chords):
    main.add(pad(notes, b - a + 1.0, attack=0.25 if k == 0 else 1.2, release=1.2, bright=br), a, -13, send=0.4)
main.add(rain(C["one"] - W0 + 1.0, 1), W0 - 0.3, -29, send=0.1)
theme = [(C["title"], "A4"), (C["title"] + 0.6, "D5"), (C["title"] + 1.2, "E5"), (C["reasons"][0], "F#5"),
         (C["reasons"][0] + 1.1, "E5"), (C["reasons"][0] + 1.6, "D5"), (C["reasons"][1], "B4"), (C["reasons"][1] + 1.1, "C#5"),
         (C["reasons"][1] + 1.6, "D5"), (C["reasons"][2], "E5"), (C["reasons"][2] + 1.3, "D5"), (C["reasons"][2] + 2.0, "A4")]
for at, name in theme:
    piano(name, at, -6, 0.6, dur=5.5)
x = C["title"]
i = 0
arp = ["D4", "A4", "E5", "F#5", "A4", "E5", "D5", "A4"]
while x < C["one"] - 0.6:
    main.add(koto(hz(arp[i % 8]), 2.2, 0.55, bright=0.5, t60=1.6), x, -21 if i % 2 else -18, pan=0.35 if i % 2 else -0.35, send=0.35)
    x += B / 2
    i += 1

# V · One anime.
O = C["one"]
main.add(pad(["G2", "D3", "F#3", "B3"], C["thread"] - O + 0.4, attack=1.0, release=1.4, bright=1100), O - 0.2, -25, send=0.5)
piano("D3", O, -12, 0.5, send=0.55)
piano("A3", O + 0.03, -13, 0.45, send=0.55)
piano("F#4", O + 0.06, -12, 0.45, send=0.6)
piano("A4", C["chosen"], -12, 0.45, send=0.6)
piano("E4", C["chosen"] + 0.9, -14, 0.4, send=0.6)
main.add(bell(hz("F#5"), 6, 1), C["never"], -24, send=0.75)
piano("A3", C["never"] + 0.02, -15, 0.4, send=0.6)

# 縁.
T, K = C["thread"], C["kanji"]
main.add(sustained("A5", K - T + 0.3, 1.8, 0.2), T, -24, send=0.6)
main.add(pad(["A1", "E2", "A2", "D3", "E3"], K - T + 0.1, attack=1.6, release=0.1, bright=900), T, -20, send=0.4)
main.add(swell(1.7, lo=200, hi=12000), K - 1.7, -11, send=0.25)
main.add(boom(5, f_hi=72, f_lo=30, vel=1), K, -3, send=0.3)
main.add(taiko(1, 1.25), K, -6, send=0.4)
for name, p in [("D5", -0.3), ("F#5", 0.3), ("A5", -0.1), ("D6", 0.1)]:
    main.add(bell(hz(name), 8, 1), K, -20, pan=p, send=0.8)
strum(main, ["D3", "A3", "D4", "F#4", "A4", "D5"], K, -9, bright=0.7, spread=0.04)
main.add(pad(["D1", "D2", "A2", "D3", "F#3", "A3", "C#4", "E4", "F#4"], DUR - K, attack=0.2, release=DUR - C["fade"] + 1.0, bright=3000), K, -11, send=0.45)
for at, name in [(K + 1.0, "A5"), (K + 1.9, "F#5"), (K + 2.8, "E5")]:
    piano(name, at, -11, 0.5, send=0.6)

# Where to find it: the last notes, under the address.
U = C["url"]
main.add(koto(hz("D5"), 5, 0.7, t60=3.4), U, -12, send=0.65)
main.add(bell(hz("A5"), 7, 1), U, -23, send=0.8)
piano("F#4", U + 0.02, -14, 0.45, send=0.6)
main.add(koto(hz("A5"), 5, 0.45, bright=0.45, t60=3.4), U + 2 * B, -17, send=0.75)


# ——— mixdown ———

print("reverb…", flush=True)
hall = make_ir(3.8, 1.8)
room = make_ir(1.8, 0.7, seed=9)
a1 = render_bus(act1, room, -5)
mix = render_bus(main, hall, -3) + a1

# Gentle glue: a slow compressor on the sum, then a soft ceiling.
mono = np.abs(mix).max(axis=0)
win = int(0.03 * SR)
envl = np.sqrt(np.maximum(movavg(mono**2, win), 0))
thr = np.percentile(envl[envl > 1e-4], 99) * 0.75
gain = np.where(envl > thr, (thr / np.maximum(envl, 1e-9)) ** 0.25, 1.0)
gain = movavg(gain, int(0.08 * SR))
mix *= gain
air = lambda f: 1 + 0.9 * (1 / (1 + (5500 / np.maximum(f, 1)) ** 2)) - 0.2 * np.exp(-((np.log2(np.maximum(f, 1) / 300)) ** 2) / 0.6)
mix = np.stack([fft_filter(mix[0], air), fft_filter(mix[1], air)])
mix /= np.abs(mix).max()
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
# Fade with the picture.
f0, f1 = int(C["fade"] * SR), min(N, int(DUR * SR))
fade = np.ones(N)
fade[f0:f1] = 0.5 + 0.5 * np.cos(np.pi * np.linspace(0, 1, f1 - f0))
fade[f1:] = 0
mix *= fade
mix *= db(-1.5)


def write_wav(path, data):
    data = np.clip(data.T, -1, 1).astype("<f4")
    with open(path, "wb") as fh:
        nbytes = data.nbytes
        fh.write(b"RIFF" + (36 + nbytes).to_bytes(4, "little") + b"WAVE")
        fh.write(b"fmt " + (16).to_bytes(4, "little") + (3).to_bytes(2, "little") + (2).to_bytes(2, "little"))
        fh.write(SR.to_bytes(4, "little") + (SR * 8).to_bytes(4, "little") + (8).to_bytes(2, "little") + (32).to_bytes(2, "little"))
        fh.write(b"data" + nbytes.to_bytes(4, "little") + data.tobytes())


raw = OUT / "score-raw.wav"
write_wav(raw, mix)

# Loudness: measure, then one fixed gain to -15 LUFS with -1 dB true peak.
print("loudness…", flush=True)
probe = subprocess.run(
    ["ffmpeg", "-hide_banner", "-i", str(raw), "-af", "loudnorm=I=-15:TP=-1:LRA=18:print_format=json", "-f", "null", "-"],
    capture_output=True, text=True,
)
stats = json.loads(probe.stderr[probe.stderr.rindex("{"):probe.stderr.rindex("}") + 1])
print("measured", stats["input_i"], "LUFS, peak", stats["input_tp"], flush=True)
lift = -15 - float(stats["input_i"])
peak_room = -1 - float(stats["input_tp"])
gain_db = min(lift, peak_room)
if lift > peak_room:
    print(f"held to {gain_db:.1f} dB by the peak ceiling", flush=True)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", f"volume={gain_db:.2f}dB", "-c:a", "pcm_f32le", str(OUT / "score.wav")],
    check=True,
)
print(OUT / "score.wav")
