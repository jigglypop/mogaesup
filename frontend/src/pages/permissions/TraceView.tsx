import type { Expansion, Trace, UserNames } from '../../api/permissions';
import { allowedPath, expansionText, traceText } from './view';

function TraceItem({ node, users }: { node: Trace; users: UserNames }) {
  const text = traceText(node, users);
  return (
    <li className={node.allowed ? 'is-ok' : 'is-no'}>
      <span>{text}</span>
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child, index) => (
            <TraceItem key={index} node={child} users={users} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** A check's decision: the path that granted it, and every branch tried. */
export function TraceView({ trace, users }: { trace: Trace; users: UserNames }) {
  const path = allowedPath(trace)
    .map((node) => traceText(node, users))
    .filter(Boolean);
  return (
    <div className="mg-perm-trace">
      <p>
        <span className={`mg-badge ${trace.allowed ? 'is-published' : 'is-error'}`}>{trace.allowed ? '허용' : '거부'}</span>
        {trace.allowed && <span className="mg-perm-path">{path.join(' → ')}</span>}
      </p>
      <details open={!trace.allowed}>
        <summary>전체 판단</summary>
        <ul className="mg-perm-tree">
          <TraceItem node={trace} users={users} />
        </ul>
      </details>
    </div>
  );
}

function ExpansionItem({ node, users }: { node: Expansion; users: UserNames }) {
  return (
    <li className={`is-${node.kind}`}>
      <span>{expansionText(node, users)}</span>
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map((child, index) => (
            <ExpansionItem key={index} node={child} users={users} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Who holds a relation, as the rules and grants that give it. */
export function ExpansionView({ tree, users }: { tree: Expansion; users: UserNames }) {
  return (
    <ul className="mg-perm-tree">
      <ExpansionItem node={tree} users={users} />
    </ul>
  );
}
