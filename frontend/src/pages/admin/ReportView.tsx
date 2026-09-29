import type { ImportReport } from '../../api/types';
import { LEVEL_LABEL, formatBytes, formatCount, textureText } from './catalogView';

/** An import report: every check with its level, then what the model holds and how its textures changed. */
export function ReportView({ report }: { report: ImportReport }) {
  const { model, file, source } = report;
  const size = model?.size;
  return (
    <div className="mg-admin-report">
      <ul className="mg-admin-checks">
        {report.checks.map((check, index) => (
          <li key={`${check.code}-${index}`} className={`is-${check.level}`}>
            <span className="mg-admin-level">{LEVEL_LABEL[check.level]}</span>
            <span>{check.message}</span>
          </li>
        ))}
      </ul>
      {model && (
        <dl className="mg-admin-stats">
          <div>
            <dt>삼각형</dt>
            <dd>{formatCount(model.triangles)}</dd>
          </div>
          <div>
            <dt>정점</dt>
            <dd>{formatCount(model.vertices)}</dd>
          </div>
          <div>
            <dt>높이</dt>
            <dd>{size ? `${size[1].toFixed(2)} m` : '—'}</dd>
          </div>
          <div>
            <dt>관절</dt>
            <dd>{model.skinned ? formatCount(model.joints) : '리깅 없음'}</dd>
          </div>
          <div>
            <dt>메시 · 재질</dt>
            <dd>
              {model.meshes} · {model.materials}
            </dd>
          </div>
          <div>
            <dt>파일</dt>
            <dd>
              {formatBytes(file?.bytes)}
              {file?.webBytes ? ` → ${formatBytes(file.webBytes)}` : ''}
            </dd>
          </div>
        </dl>
      )}
      {model && model.animations.length > 0 && (
        <div className="mg-admin-chips" aria-label="애니메이션">
          <b>애니메이션</b>
          {model.animations.map((name, index) => (
            <span key={`${name}-${index}`} className="mg-badge">
              {name}
            </span>
          ))}
        </div>
      )}
      {model && model.textures.length > 0 && (
        <div className="mg-admin-scroll">
          <table className="mg-table mg-admin-textures">
            <thead>
              <tr>
                <th>텍스처</th>
                <th>원본</th>
                <th>웹용</th>
              </tr>
            </thead>
            <tbody>
              {model.textures.map((texture) => (
                <tr key={texture.image}>
                  <td>#{texture.image}</td>
                  <td>{textureText(texture)}</td>
                  <td>{textureText(report.webTextures?.find((web) => web.image === texture.image))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(source || file) && (
        <p className="mg-admin-fineprint">
          {source && (
            <>
              원본 <code>{[source.jobId, source.version, source.face].filter(Boolean).join('/')}</code>
              {source.stage ? ` · ${source.stage}` : ''}
            </>
          )}
          {file && (
            <>
              {source ? ' · ' : ''}SHA-256 <code>{file.sha256.slice(0, 12)}…</code>
            </>
          )}
        </p>
      )}
    </div>
  );
}
