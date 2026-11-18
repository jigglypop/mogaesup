import { useState } from 'react';

import { problemText } from '../../api/client';
import { sajuApi } from '../../api/endpoints';
import type { GiftDesign } from '../../api/types';
import type { Compat } from '../compat';
import { elementLabel } from '../elements';
import { pillarsOf, readingOf, type Birth } from '../engine';
import { GIFT_FORMS, GIFT_STONES } from '../gifts';
import type { Resident } from '../residents';
import './compatGift.css';

const pillars = (birth: Birth) => pillarsOf(readingOf(birth)).map(({ pillar }) => pillar.cn);

export function CompatGiftCard({ giverId, giver, recipient, compat }: {
  giverId: string;
  giver: Resident;
  recipient: Resident;
  compat: Compat;
}) {
  const [delivery, setDelivery] = useState<'ready' | 'sending' | 'sent'>('ready');
  const [problem, setProblem] = useState('');
  const { tone, from, to } = compat;
  const design: GiftDesign = { tone, from, to };
  const form = GIFT_FORMS[tone];
  const give = async () => {
    if (delivery !== 'ready') return;
    setDelivery('sending');
    setProblem('');
    try {
      await sajuApi.giveGift(recipient.id, {
        expectedGiverId: giverId, giverBirth: giver.birth, recipientBirth: recipient.birth, design,
        giverPillars: pillars(giver.birth), recipientPillars: pillars(recipient.birth),
      });
      setDelivery('sent');
    } catch (error) {
      setDelivery('ready');
      setProblem(problemText(error));
    }
  };
  return (
    <section className="mg-saju-card mg-saju-gift" aria-label="궁합 선물">
      <h2 className="mg-heading">궁합 선물</h2>
      <div className="mg-saju-gift-preview">
        <div className="mg-saju-gift-picture" data-pair={tone === 'same'}>
          <img src={`/gltf/decor/thumbs/${form.model}.webp`} alt="" />
          {tone === 'same' && <img src={`/gltf/decor/thumbs/${form.model}.webp`} alt="" />}
        </div>
        <div>
          <strong>{form.name}</strong>
          {[from, to].map((element, index) => (
            <small key={index}><i style={{ backgroundColor: GIFT_STONES[element].color }} />{index === 0 ? giver.name : recipient.name}의 {elementLabel(element)} · {GIFT_STONES[element].name}</small>
          ))}
        </div>
      </div>
      <p className="mg-saju-gift-reading">{compat.headline}</p>
      {delivery === 'sent' ? (
        <p className="mg-muted" role="status">{recipient.name}님의 꾸미기 보관함에 선물을 보냈어요.</p>
      ) : (
        <button className="mg-btn is-primary" disabled={delivery === 'sending'} onClick={() => void give()}>
          {delivery === 'sending' ? '보내는 중…' : `${recipient.name}님에게 선물하기`}
        </button>
      )}
      {problem && <p className="mg-error" role="alert">{problem}</p>}
    </section>
  );
}
