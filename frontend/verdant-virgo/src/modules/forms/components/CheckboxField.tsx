// 任意のチェックボックス（無料 DL フォームの「お知らせメール」。01-content-spec.md §5.2 の 3）。
// 「任意」の印は付けない（§5.2 の例外）。初期値はチェックなし。
import { useId } from 'react';
import { Checkbox } from '@/components/ui/checkbox';

interface CheckboxFieldProps {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}

export default function CheckboxField({ id, label, checked, onCheckedChange, disabled }: CheckboxFieldProps) {
  // span の role=checkbox は label から名前を受け取れないので、HTML の時点から aria-labelledby で文字を指す
  const labelId = `${useId()}-label`;
  return (
    <label className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        aria-labelledby={labelId}
        className="mt-1"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        disabled={disabled}
      />
      <span id={labelId} className="phrase">{label}</span>
    </label>
  );
}
