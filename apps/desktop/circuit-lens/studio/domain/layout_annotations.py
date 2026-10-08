"""Preserve author text without making it an electrical placement node."""
from studio.domain.schematic_layout import _attr, _snap


def arrange_annotations(layout, intent, groups, members, legacy):
    texts = {cid:c for cid,c in layout.by_id.items()
             if cid in layout.body_ids and c['factoryName']=='Text'}
    by_group = {g['id']:g for g in groups}
    explicit = {}
    for item in intent.get('annotations', []):
        cid = item['componentId']
        if cid not in texts or cid in explicit:
            raise ValueError(f'注释对象不存在、固定或重复: {cid}')
        role = item.get('role', 'overview')
        if role not in ('heading','overview'):
            raise ValueError(f'未知注释角色: {role}')
        if role == 'heading' and item.get('groupId') not in by_group:
            raise ValueError(f'标题引用未知分组: {item.get("groupId")}')
        explicit[cid] = item
    result, top = [], 0
    for cid,c in sorted(texts.items(), key=lambda pair:(pair[1]['bounds']['y'],pair[1]['bounds']['x'],pair[0])):
        b = c.get('visualBounds',c['bounds'])
        item = explicit.get(cid, {})
        gid = item.get('groupId', legacy.get(cid))
        group = by_group.get(gid)
        role = item.get('role','overview')
        # Compatibility with old plans containing Text: only reuse a compact
        # original heading above its owned parts. Long legends and other notes
        # keep their native text/style in a separate overview band.
        if cid not in explicit and group and not group.get('sourceHeading'):
            source_top = min((layout.by_id[p]['bounds']['y'] for p in members[gid]),default=float('inf'))
            if b['y']+b['height'] <= source_top and b['width'] <= group['width']-40 and b['height'] <= 35:
                role = 'heading'
        if role == 'heading':
            if group.get('sourceHeading') or b['width'] > group['width']-40 or b['height'] > 35:
                raise ValueError(f'分组标题重复或无法容纳原文: {cid}；使用 overview 保留完整说明。')
            group['sourceHeading'] = cid
            x,y = group['x']+20,group['y']+5
        else:
            x,y = 0,top
            top += _snap(b['height']+25)
        result.append({'componentId':cid,'text':_attr(c,'text') or '', 'role':role,
                       'groupId':gid,'x':x,'y':y,'width':b['width'],'height':b['height']})
    return result, top+30 if top else 0
