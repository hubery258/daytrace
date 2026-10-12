"""Explicit test-user confirmation for older portability regression scenarios."""
from app.data_portability import import_package as execute, preview_package


async def confirmed_import(db, package, mode='merge'):
    choices = {}
    preview = await preview_package(db, package, mode)
    for conflict in preview['conflicts']:
        if conflict['kind'] == 'rename':
            choices[conflict['id']] = {'side': 'edit', 'value': conflict['local'] + ' ' + conflict['id'].split(':')[1][:8]}
        elif conflict['kind'] == 'date':
            choices[conflict['id']] = {'side': 'edit', 'value': conflict['local'] or conflict['incoming'] or '2026-10-11'}
        elif conflict['kind'] == 'active_timer':
            choices[conflict['id']] = {'side': 'select', 'value': conflict['options'][0]['uuid'], 'paused_at': '2099-01-01T00:00:00'}
        else:
            choices[conflict['id']] = {'side': 'incoming'}
    preview = await preview_package(db, package, mode, choices)
    return await execute(db, package, mode, choices, preview['token'])
