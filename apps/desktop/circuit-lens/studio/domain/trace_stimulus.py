"""Optional periodic Pin stimuli, lowered to the existing ordered input events."""
from __future__ import annotations

from studio.domain.tool_errors import CircuitToolError


def expand_input_clocks(specs, inputs, input_events, components, ticks):
    """Explicit events precede clock transitions at each tick; each settles.

    The caller validates explicit events. Clock values start at inputs[name]
    and toggle at firstTick, then after the duration of the new high/low level.
    lastTick is inclusive; the final value persists afterwards. No net, edge,
    reset, or cycle is inferred from circuit names or component types.
    """
    def reject(message):
        raise CircuitToolError(
            'INVALID_CLOCK_STIMULUS', message,
            hint='inputClocks 使用唯一的1位输入引脚标签，在 inputs 中指定初值0或1；'
                 'firstTick/lastTick 在本次范围内，高低持续时间为正整数。'
                 '同一引脚不同时使用 inputEvents；任意波形仍可全部用 inputEvents。')

    if not isinstance(specs, list) or len(specs) > 16:
        reject('inputClocks 必须为最多16项的数组。')
    normalized, generated, seen = [], [], set()
    explicit_names = {event['name'] for event in input_events}
    for spec in specs:
        if not isinstance(spec, dict) or set(spec) - {'name', 'firstTick', 'lastTick', 'highTicks', 'lowTicks'}:
            reject('时钟激励仅接受 name、firstTick、lastTick、highTicks、lowTicks。')
        name = spec.get('name')
        if not isinstance(name, str) or not name.strip() or name in seen:
            reject('时钟输入 name 必须非空且唯一。')
        seen.add(name)
        pins = [c for c in components if c.get('factoryName') == 'Pin'
                and ((c.get('selector') or {}).get('label') or c.get('label')) == name
                and any(e.get('direction') == 'output' for e in c.get('ends', []))]
        if len(pins) != 1 or len(pins[0]['ends']) != 1 or pins[0]['ends'][0].get('width') != 1:
            reject(f'时钟输入 {name} 必须唯一对应当前电路的1位输入 Pin。')
        if type(inputs.get(name)) is not int or inputs[name] not in (0, 1):
            reject(f'请在 inputs 中指定时钟输入 {name} 的初值0或1。')
        if name in explicit_names:
            reject(f'输入 {name} 同时出现在 inputClocks 和 inputEvents 中。')
        clock = {'name': name, 'firstTick': spec.get('firstTick', 1),
                 'lastTick': spec.get('lastTick', ticks),
                 'highTicks': spec.get('highTicks', 1), 'lowTicks': spec.get('lowTicks', 1)}
        if any(type(clock[k]) is not int for k in ('firstTick', 'lastTick', 'highTicks', 'lowTicks')):
            reject(f'时钟输入 {name} 的 tick 和持续时间必须为整数。')
        if not 0 <= clock['firstTick'] <= clock['lastTick'] <= ticks:
            reject(f'时钟输入 {name} 要求 0 ≤ firstTick ≤ lastTick ≤ ticks。')
        if not 1 <= clock['highTicks'] <= 10000 or not 1 <= clock['lowTicks'] <= 10000:
            reject(f'时钟输入 {name} 的高低持续时间必须在1–10000之间。')
        normalized.append(clock)
        tick, value = clock['firstTick'], inputs[name]
        while tick <= clock['lastTick']:
            value = 1 - value
            generated.append({'name': name, 'tick': tick, 'value': value})
            tick += clock['highTicks'] if value else clock['lowTicks']
    # Stable sorting retains explicit array order, then clock declaration order
    # within a tick. Hashing these executed events also identifies equivalent
    # explicit and periodic requests without returning the expanded bulk.
    events = sorted([*input_events, *generated], key=lambda event: event['tick'])
    return events, normalized
