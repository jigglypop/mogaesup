import re
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[2] / 'infra' / 'ec2.yaml'
# The user data the template renders without a records database. Changing it is an update of the instance
# (CloudFormation stops and starts it, or replaces it), so it only changes on purpose: update this with it. The
# PUBLIC_SITE_ORIGIN line left with the unused PublicSiteOrigin parameter.
USER_DATA_BEFORE = r'''#!/bin/bash
set -euo pipefail
# curl-minimal already provides curl; installing the full package conflicts with it.
dnf install -y docker
systemctl enable --now docker
install -d -m 700 /opt/asset-studio
cat > /etc/asset-studio.env <<'CONFIG'
ASSET_S3_BUCKET='${AssetBucket}'
AWS_REGION='${AWS::Region}'
PROVIDER_SECRET_ARN='${ProviderSecretArn}'
PUBLIC_STUDIO='${PublicStudio}'
CONFIG
chmod 600 /etc/asset-studio.env
release_sha="$(basename '${ReleaseKey}' .tar.gz)"
exec 8>/var/lock/asset-studio-prepare.lock
flock -n 8 || { echo 'another release preparation is active' >&2; exit 3; }
incoming="/opt/asset-studio/incoming/$release_sha"
install -d -m 700 "$incoming/source"
aws s3 cp 's3://${AssetBucket}/${ReleaseKey}' "$incoming/release.tar.gz" --region '${AWS::Region}' --checksum-mode ENABLED --only-show-errors
printf '%s  %s\n' "$release_sha" "$incoming/release.tar.gz" | sha256sum -c -
tar -xzf "$incoming/release.tar.gz" -C "$incoming/source"
printf '%s\n' "$release_sha" > "$incoming/source/.release-sha256"
/bin/bash "$incoming/source/infra/deploy-on-instance.sh" '${ReleaseKey}' "$release_sha" "$incoming/source"
'''
OPENING = 'Fn::Base64: !Sub\n          - |\n'


@pytest.fixture(scope='module')
def template():
    return TEMPLATE.read_text(encoding='utf-8')


def user_data(template):
    start = template.index(OPENING) + len(OPENING)
    block = template[start:template.index('\n          - CharacterDbConfig:', start)]
    return ''.join(line[12:] + '\n' for line in block.split('\n'))


def config_variable(template):
    return template[template.index('- CharacterDbConfig:'):template.index('\n  StudioAddress:')]


def storage_statements(template):
    policy = template[template.index('        - PolicyName: StudioStorage'):template.index('\n  Profile:')]
    return re.split(r'\n\s+- Effect: ', policy)[1:]


def parameter(template, name):
    return re.search(rf'\n  {name}:\n((?:    .*\n)+)', template).group(1)


def test_the_user_data_is_unchanged_without_a_records_database(template):
    assert user_data(template).replace('${CharacterDbConfig}', '') == USER_DATA_BEFORE
    # The variable sits at the end of the PUBLIC_STUDIO line and is empty unless both values are given.
    assert "PUBLIC_STUDIO='${PublicStudio}'${CharacterDbConfig}\nCONFIG\n" in user_data(template)
    variable = config_variable(template)
    assert variable.startswith('- CharacterDbConfig: !If\n              - HasCharacterDb\n') and variable.rstrip().endswith("- ''")


def test_the_records_database_lines_are_the_ones_records_to_postgres_writes(template):
    variable = config_variable(template)
    assert '"\\nCHARACTER_DB_SECRET_ARN=\'"' in variable and '"\'\\nCHARACTER_DB_HOST=\'"' in variable
    assert '!Ref CharacterDbSecretArn' in variable and '!Ref CharacterDbHost' in variable
    script = (TEMPLATE.parent / 'records-to-postgres.py').read_text(encoding='utf-8')
    assert "CHARACTER_DB_SECRET_ARN='%s'\\nCHARACTER_DB_HOST='%s'" in script


@pytest.mark.parametrize('name', ['CharacterDbSecretArn', 'CharacterDbHost'])
def test_the_records_parameters_are_optional(template, name):
    block = parameter(template, name)
    assert "Default: ''" in block and "AllowedPattern: '^$|" in block


def test_the_records_parameters_come_as_a_pair(template):
    assert 'CharacterDbPair:' in template
    assert ("HasCharacterDb: !And [!Not [!Equals [!Ref CharacterDbSecretArn, '']], "
            "!Not [!Equals [!Ref CharacterDbHost, '']]]") in template


def test_the_role_may_delete_under_assets_and_nowhere_else(template):
    deleting = [statement for statement in storage_statements(template) if 's3:DeleteObject' in statement]
    assert len(deleting) == 1 and template.count('s3:DeleteObject') == 1
    assert "'s3:GetObject', 's3:PutObject', 's3:DeleteObject'" in deleting[0]
    assert "${AssetBucket}/assets/*'" in deleting[0] and 'releases' not in deleting[0]


def test_the_records_secret_is_readable_only_when_given(template):
    reading = [statement for statement in storage_statements(template) if 'secretsmanager:GetSecretValue' in statement]
    assert len(reading) == 1 and template.count('secretsmanager:GetSecretValue') == 1
    assert '!Ref ProviderSecretArn' in reading[0]
    assert '!If [HasCharacterDb, !Ref CharacterDbSecretArn, !Ref AWS::NoValue]' in reading[0]


def test_the_image_still_follows_the_latest_al2023_and_says_how_to_pin_it(template):
    block = parameter(template, 'ImageId')
    comment, declaration = block.split('    Type:', 1)
    assert "'AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>'" in declaration
    assert 'Default: /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64' in declaration
    assert 'pin' in comment and 'AWS::EC2::Image::Id' in comment


def test_the_gateway_key_is_part_of_the_cache_key(template):
    # An origin 403 for a request without the key must never be served from the cache to one that has it.
    assert 'HeadersConfig: {HeaderBehavior: whitelist, Headers: [Authorization, x-gateway-key]}' in template


def test_the_template_does_not_promise_a_static_site(template):
    assert 'static' not in re.search(r'^Description: (.*)$', template, re.M).group(1)
    assert 'PublicSiteOrigin' not in template and 'PUBLIC_SITE_ORIGIN' not in template


def test_port_80_is_open_to_cloudfront_only(template):
    ingress = re.findall(r'\n  (\w+):\n    Type: AWS::EC2::SecurityGroupIngress\n((?:    .*\n)+)', template)
    assert [name for name, _ in ingress] == ['CloudFrontHttpIngress']
    assert 'SourcePrefixListId: !Ref CloudFrontPrefixListId' in ingress[0][1] and 'CidrIp' not in ingress[0][1]
    assert 'Condition: HasPublicStudio' in ingress[0][1]


def test_the_template_says_a_stack_update_must_pass_the_current_release(template):
    head = template[:template.index('Parameters:')]
    assert 'ReleaseKey' in head and 'current.json' in head
