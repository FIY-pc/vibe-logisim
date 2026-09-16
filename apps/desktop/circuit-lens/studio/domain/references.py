"""Version-bound links understood by the shared circuit canvas."""
from urllib.parse import urlencode
import json


def object_link(project, revision, circuit, component, sample=None):
    scope = {'sessionId':sample['sessionId'], 'instancePath':json.dumps(sample['instancePath'],ensure_ascii=False,separators=(',',':'))} if sample else {}
    return 'circuit://object?' + urlencode({'projectId':project,'revisionId':revision,'circuit':circuit,'componentId':component,**scope})

