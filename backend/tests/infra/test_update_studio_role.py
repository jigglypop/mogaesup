"""backend/infra/update-studio-role.py: the change set it builds and what it lets run."""
import importlib.util
import json
from pathlib import Path

import pytest

INFRA = Path(__file__).resolve().parents[2] / 'infra'
IMAGE = 'ami-0123456789abcdef0'
# The layout of the template the stack ran before ImageId was pinned (as the repository had it until 2026-10-05).
LIVE = '''AWSTemplateFormatVersion: '2010-09-09'
Parameters:
  AssetBucket:
    Type: String
  ReleaseKey:
    Type: String
  PublicSiteOrigin:
    Type: String
    Default: ''
  ImageId:
    # Resolved again on every stack update.
    Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>'
    Default: /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64
Resources:
  InstanceRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument: {}
  Instance:
    Type: AWS::EC2::Instance
    Properties:
      ImageId: !Ref ImageId
Outputs:
  InstanceId: {Value: !Ref Instance}
'''


@pytest.fixture(scope='module')
def script():
    spec = importlib.util.spec_from_file_location('update_studio_role', INFRA / 'update-studio-role.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def change(action, name, kind, replacement=None, *targets):
    return {'Type': 'Resource', 'ResourceChange': {
        'Action': action, 'LogicalResourceId': name, 'ResourceType': kind,
        **({'Replacement': replacement} if replacement else {}),
        'Details': [{'Target': {'Attribute': attribute, 'Name': name_}} for attribute, name_ in targets]}}


def test_the_live_template_gets_a_pinned_image_and_the_policy_and_nothing_else(script):
    text = script.live_template(LIVE, IMAGE)
    assert "    Type: 'AWS::EC2::Image::Id'\nResources:" in text and 'SSM::Parameter' not in text
    before, added, after = text.partition(script.ADDON_YAML)
    assert added and after == 'Outputs:\n  InstanceId: {Value: !Ref Instance}\n'
    assert before.replace("    Type: 'AWS::EC2::Image::Id'\n", "    Type: 'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>'\n"
                          "    Default: /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64\n") + after == LIVE
    assert "Action: ['s3:DeleteObject']" in added and '${AssetBucket}/assets/*' in added


def test_an_unknown_layout_is_refused(script):
    with pytest.raises(script.Refused):
        script.live_template(LIVE.replace('  InstanceRole:', '  StudioRole:'), IMAGE)
    with pytest.raises(script.Refused):
        script.live_template(script.live_template(LIVE, IMAGE), IMAGE)


def test_a_json_template_is_edited_as_json(script):
    body = {'Parameters': {'AssetBucket': {'Type': 'String'}, 'ImageId': {'Type': script.SSM_IMAGE}},
            'Resources': {'InstanceRole': {'Type': 'AWS::IAM::Role'}}}
    text = json.loads(script.live_template(body, IMAGE))
    assert text['Parameters']['ImageId'] == {'Type': 'AWS::EC2::Image::Id', 'Default': IMAGE}
    assert text['Resources'][script.ADDON]['Type'] == 'AWS::IAM::Policy'


def test_the_image_is_the_running_one_and_everything_else_stays(script):
    names = script.template_parameters(script.live_template(LIVE, IMAGE))
    assert names == ['AssetBucket', 'ReleaseKey', 'PublicSiteOrigin', 'ImageId']
    values = script.parameters_for(names, {'AssetBucket': 'b', 'ReleaseKey': 'r', 'ImageId': '/aws/service/x'}, IMAGE)
    assert values == [{'ParameterKey': 'AssetBucket', 'UsePreviousValue': True},
                      {'ParameterKey': 'ReleaseKey', 'UsePreviousValue': True},
                      {'ParameterKey': 'ImageId', 'ParameterValue': IMAGE}]


def test_the_repository_template_pins_the_image_too(script):
    assert 'ImageId' in script.template_parameters((INFRA / 'ec2.yaml').read_text(encoding='utf-8'))


def test_only_the_added_policy_may_run_from_the_live_template(script):
    assert script.evaluate([change('Add', script.ADDON, 'AWS::IAM::Policy')], 'live') == []
    for extra in (change('Modify', 'Instance', 'AWS::EC2::Instance', 'False', ('Properties', 'UserData')),
                  change('Modify', 'Instance', 'AWS::EC2::Instance', 'True', ('Properties', 'ImageId')),
                  change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'False', ('Properties', 'Policies')),
                  change('Modify', 'StudioDistribution', 'AWS::CloudFront::Distribution', 'False'),
                  change('Remove', 'PublicHttpIngress', 'AWS::EC2::SecurityGroupIngress')):
        problems = script.evaluate([change('Add', script.ADDON, 'AWS::IAM::Policy'), extra], 'live')
        assert len(problems) == 1 and extra['ResourceChange']['LogicalResourceId'] in problems[0]
    assert script.evaluate([], 'live') == [f'the change set does not change {script.ADDON}']


def test_the_repository_template_may_move_the_policy_and_change_it(script):
    moved = [change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'False', ('Properties', 'Policies')),
             change('Add', 'StudioAccessPolicy', 'AWS::IAM::Policy')]
    assert script.evaluate(moved, 'repo') == []
    assert script.evaluate([change('Modify', 'StudioAccessPolicy', 'AWS::IAM::Policy', 'False',
                                   ('Properties', 'PolicyDocument'))], 'repo') == []
    # The role changing anything else (its trust, its managed policies) or being replaced is not a permission change.
    for role in (change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'False', ('Properties', 'AssumeRolePolicyDocument')),
                 change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'True', ('Properties', 'Policies')),
                 change('Modify', 'Profile', 'AWS::IAM::InstanceProfile', 'False', ('Properties', 'Roles'))):
        assert script.evaluate([*moved, role], 'repo')
    assert script.evaluate([*moved, change('Modify', 'SecurityGroup', 'AWS::EC2::SecurityGroup', 'True',
                                           ('Properties', 'GroupDescription'))], 'repo')


def test_the_repository_template_takes_over_from_the_live_add_on(script):
    # After one --from live --execute the stack has the add-on: the next change goes --from repo, which removes it.
    policy = change('Modify', 'StudioAccessPolicy', 'AWS::IAM::Policy', 'False', ('Properties', 'PolicyDocument'))
    removed = change('Remove', script.ADDON, 'AWS::IAM::Policy')
    assert script.evaluate([policy, removed], 'repo') == []
    assert script.evaluate([change('Modify', 'InstanceRole', 'AWS::IAM::Role', 'False', ('Properties', 'Policies')),
                            change('Add', 'StudioAccessPolicy', 'AWS::IAM::Policy'), removed], 'repo') == []
    # The repository's StudioAccessPolicy is in place as the stack has it; only the add-on goes.
    assert script.evaluate([removed], 'repo') == []
    # Only that policy, only removed, and only from the repository's template.
    for other in (change('Remove', script.ADDON, 'AWS::IAM::ManagedPolicy'),
                  change('Modify', script.ADDON, 'AWS::IAM::Policy', 'False', ('Properties', 'PolicyDocument')),
                  change('Remove', 'StudioAccessPolicy', 'AWS::IAM::Policy'),
                  change('Remove', 'InstanceRole', 'AWS::IAM::Role')):
        assert script.evaluate([policy, other], 'repo')
    assert script.evaluate([removed], 'live')


def test_the_repository_policy_holds_what_the_add_on_gave(script):
    text = (INFRA / 'ec2.yaml').read_text(encoding='utf-8')
    policy = text[text.index('  StudioAccessPolicy:'):text.index('  Profile:')]
    assert "'s3:DeleteObject'" in policy and '${AssetBucket}/assets/*' in policy
    assert "['ssm:PutParameter']" in policy and 'parameter/asset-studio/current-release' in policy
