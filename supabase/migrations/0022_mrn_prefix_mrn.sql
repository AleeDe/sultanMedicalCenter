/*
  The MRN prefix becomes MRN, not BT.

  0018 defaulted it to the clinic's initials on the assumption that a branch
  code was the useful thing to carry. It is not: reception reads this number
  aloud and writes it on a file, and "MRN" says what the number IS. A patient
  asked for their "BT number" does not know what is being asked; asked for
  their MRN, they hand over the slip.

  Nothing else changes. The prefix has lived in clinic_setting since 0018
  precisely so this is one row, not a deploy — and existing MRNs are left
  exactly as they are, as always. That leaves three shapes in circulation:

    MRN-000451        the original series, still valid, never rewritten
    BT-260825-0417    issued between 0018 and this migration
    MRN-260825-0417   from here on

  They cannot collide: the legacy series has one number group and the dated
  series has two, and mrn is unique regardless. classifyQuery() already reads
  all three, so a patient holding any of them can still be found.
*/

update clinic_setting set mrn_prefix = 'MRN' where id = 1;
